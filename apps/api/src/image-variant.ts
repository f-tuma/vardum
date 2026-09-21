import { createHash } from "node:crypto";
import sharp from "sharp";
import { config } from "./config.js";
import { CapacityError } from "./resource-budget.js";
import { withTransformBudget, outputPixels } from "./transform-budget.js";
import { getObject, putDerivedObject, readBoundedObject } from "./storage.js";
import {
  canonicalizeTransformation,
  type Transformation,
} from "./transformation.js";

// libvips threads/cache are per process, independently of request admission.
sharp.concurrency(1);
sharp.cache({ memory: 32, files: 0, items: 100 });

type Source = {
  id: string;
  storageKey: string;
  mimeType: string;
  size: number;
};

// ponytail: process-local lock; use a distributed lock if duplicate cross-node work is measured.
const generating = new Map<string, Promise<void>>();

export async function getImageVariant(
  source: Source,
  transformation: Transformation,
) {
  const canonical = canonicalizeTransformation(transformation);
  const hash = createHash("sha256").update(`v1:${canonical}`).digest("hex");
  const outputFormat =
    transformation.format ??
    (source.mimeType === "image/svg+xml" ? "png" : undefined);
  const extension = outputFormat ?? extensionForMimeType(source.mimeType);
  const mimeType = outputFormat ? `image/${outputFormat}` : source.mimeType;
  const storageKey = `derived/v1/${source.id}/${hash}.${extension}`;

  try {
    return { object: await getObject(storageKey), mimeType, cacheHit: true };
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }

  let generation = generating.get(storageKey);
  if (!generation) {
    generation = withTransformBudget((signal) =>
      generate(
        source,
        storageKey,
        mimeType,
        transformation,
        outputFormat,
        signal,
      ),
    ).finally(() => {
      generating.delete(storageKey);
    });
    generating.set(storageKey, generation);
  }
  await generation;
  return { object: await getObject(storageKey), mimeType, cacheHit: false };
}

async function generate(
  source: Source,
  storageKey: string,
  mimeType: string,
  transformation: Transformation,
  outputFormat: "avif" | "jpeg" | "png" | "webp" | undefined,
  signal: AbortSignal,
) {
  const boundedSignal = AbortSignal.any([
    signal,
    AbortSignal.timeout(config.TRANSFORM_TIMEOUT_SECONDS * 1000),
  ]);
  const original = await getObject(source.storageKey, undefined, boundedSignal);
  const bytes = await readBoundedObject(
    original,
    Math.min(source.size, config.UPLOAD_MAX_IMAGE_MB * 1024 ** 2),
    boundedSignal,
  );
  let image = sharp(bytes, {
    animated: true,
    limitInputPixels: 100_000_000,
  }).timeout({ seconds: config.TRANSFORM_TIMEOUT_SECONDS });
  const metadata = await image.metadata();
  if (
    !metadata.width ||
    !metadata.height ||
    outputPixels(
      metadata.width,
      metadata.pageHeight ?? metadata.height,
      metadata.pages ?? 1,
      transformation,
    ) > config.TRANSFORM_MAX_OUTPUT_PIXELS
  )
    throw new CapacityError(
      "Transformed image exceeds the output pixel limit. Request smaller dimensions.",
      422,
    );

  if (transformation.w || transformation.h) {
    image = image.resize({
      width: transformation.w,
      height: transformation.h,
      fit: transformation.fit ?? "inside",
    });
  }
  const quality = transformation.q ?? 80;
  switch (outputFormat) {
    case "avif":
      image = image.avif({ quality });
      break;
    case "jpeg":
      image = image.jpeg({ quality });
      break;
    case "png":
      image = image.png({ quality });
      break;
    case "webp":
      image = image.webp({ quality });
      break;
  }

  boundedSignal.throwIfAborted();
  const result = await image.toBuffer();
  boundedSignal.throwIfAborted();
  await putDerivedObject(storageKey, result, mimeType, boundedSignal);
}

function extensionForMimeType(mimeType: string) {
  return mimeType === "image/jpeg" ? "jpeg" : mimeType.slice("image/".length);
}

function isNotFound(error: unknown) {
  if (typeof error !== "object" || error === null) return false;
  if ("name" in error && error.name === "NoSuchKey") return true;
  if (
    !("$metadata" in error) ||
    typeof error.$metadata !== "object" ||
    !error.$metadata
  ) {
    return false;
  }
  return (
    "httpStatusCode" in error.$metadata &&
    error.$metadata.httpStatusCode === 404
  );
}

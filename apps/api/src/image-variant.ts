import { createHash } from "node:crypto";
import sharp from "sharp";
import { getObject, putDerivedObject } from "./storage.js";
import {
  canonicalizeTransformation,
  type Transformation,
} from "./transformation.js";

type Source = {
  id: string;
  storageKey: string;
  mimeType: string;
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
    return { object: await getObject(storageKey), mimeType };
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }

  let generation = generating.get(storageKey);
  if (!generation) {
    generation = generate(
      source,
      storageKey,
      mimeType,
      transformation,
      outputFormat,
    ).finally(() => {
      generating.delete(storageKey);
    });
    generating.set(storageKey, generation);
  }
  await generation;
  return { object: await getObject(storageKey), mimeType };
}

async function generate(
  source: Source,
  storageKey: string,
  mimeType: string,
  transformation: Transformation,
  outputFormat?: "avif" | "jpeg" | "png" | "webp",
) {
  const original = await getObject(source.storageKey);
  if (!original.Body) throw new Error("S3 returned an empty body");
  const bytes = Buffer.from(await original.Body.transformToByteArray());
  let image = sharp(bytes, { animated: true, limitInputPixels: 100_000_000 });

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

  await putDerivedObject(storageKey, await image.toBuffer(), mimeType);
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

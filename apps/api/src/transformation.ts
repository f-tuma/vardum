import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { config } from "./config.js";

const fields = {
  w: z.coerce.number().int().min(1).max(4096).optional(),
  h: z.coerce.number().int().min(1).max(4096).optional(),
  fit: z.enum(["cover", "contain", "fill", "inside", "outside"]).optional(),
  format: z.enum(["avif", "jpeg", "png", "webp"]).optional(),
  q: z.coerce.number().int().min(1).max(100).optional(),
  bg: z.string().regex(/^#[0-9a-fA-F]{6}$/, "Background must be a six-digit hex color")
    .toLowerCase().optional(),
  // JSON bodies must not coerce null, booleans or empty strings into a percent.
  pad: z.union([z.number().int().min(0).max(45), z.string().regex(/^0*(?:[0-9]|[1-3][0-9]|4[0-5])$/)])
    .pipe(z.coerce.number<string | number>().int().min(0).max(45))
    .describe('Inset on each edge as an integer percent (0–45) of the shorter final side. Positive padding requires explicit w, h, raster format and fit "contain".')
    .optional(),
};
const baseSchema = z.object(fields).strict();
export type Transformation = z.infer<typeof baseSchema>;

export const transformationSchema = baseSchema.superRefine((value, context) => {
  const issue = transformationIssue(value);
  if (issue) context.addIssue({ code: "custom", message: issue });
});
export const transformationQuerySchema = z
  .object({ ...fields, sig: z.string().min(1) })
  .strict()
  .superRefine((value, context) => {
    const issue = transformationIssue(value);
    if (issue) context.addIssue({ code: "custom", message: issue });
  });
export const deliveryQuerySchema = z.union([
  z.object({}).strict(),
  transformationQuerySchema,
]);

export function canonicalizeTransformation(input: Transformation) {
  const query = new URLSearchParams();
  if (input.w) query.set("w", String(input.w));
  if (input.h) query.set("h", String(input.h));
  if (input.w || input.h) query.set("fit", input.fit ?? "inside");
  if (input.format) {
    query.set("format", input.format);
    query.set("q", String(input.q ?? 80));
  }
  if (input.bg) query.set("bg", input.bg.toLowerCase());
  if (input.pad) query.set("pad", String(input.pad));
  return query.toString();
}

export function signTransformation(
  workspaceSlug: string,
  key: string,
  input: Transformation,
) {
  return signature(workspaceSlug, key, canonicalizeTransformation(input));
}

export function originalAssetUrl(
  workspaceSlug: string,
  key: string,
  customDomain?: string | null,
) {
  const encodedKey = key.split("/").map(encodeURIComponent).join("/");
  return customDomain
    ? `https://${customDomain}/w/${encodedKey}`
    : `/w/${encodeURIComponent(workspaceSlug)}/${encodedKey}`;
}

export function transformedAssetUrl(
  workspaceSlug: string,
  key: string,
  input: Transformation,
  customDomain?: string | null,
) {
  return transformedUrl(workspaceSlug, key, input, customDomain);
}

export function transformedVersionUrl(
  workspaceSlug: string,
  key: string,
  versionId: string,
  input: Transformation,
  customDomain?: string | null,
) {
  return transformedUrl(workspaceSlug, key, input, customDomain, versionId);
}

function transformedUrl(
  workspaceSlug: string,
  key: string,
  input: Transformation,
  customDomain?: string | null,
  versionId?: string,
) {
  const encodedKey = key.split("/").map(encodeURIComponent).join("/");
  const query = canonicalizeTransformation(input);
  const signed = signTransformation(workspaceSlug, key, input);
  const version = versionId ? `__v/${encodeURIComponent(versionId)}/` : "";
  const path = customDomain
    ? `https://${customDomain}/w/${version}${encodedKey}`
    : `/w/${encodeURIComponent(workspaceSlug)}/${version}${encodedKey}`;
  return `${path}?${query}&sig=${encodeURIComponent(signed)}`;
}

export function verifyTransformation(
  workspaceSlug: string,
  key: string,
  input: Transformation,
  supplied: string,
) {
  const expected = signTransformation(workspaceSlug, key, input);
  const expectedBytes = Buffer.from(expected);
  const suppliedBytes = Buffer.from(supplied);
  return (
    expectedBytes.length === suppliedBytes.length &&
    timingSafeEqual(expectedBytes, suppliedBytes)
  );
}

function signature(workspaceSlug: string, key: string, canonical: string) {
  return createHmac("sha256", config.TRANSFORM_SECRET)
    .update(`${workspaceSlug}/${key}?${canonical}`)
    .digest("base64url");
}

function transformationIssue(input: Transformation) {
  if (input.pad && (!input.w || !input.h || !input.format || input.fit !== "contain"))
    return 'Padding requires width, height, an output format and fit "contain"';
  if (input.bg && !input.format) return "Background requires an output format";
  if (!input.w && !input.h && !input.format)
    return "A size or output format is required";
  if (input.fit && !input.w && !input.h)
    return "Fit requires a width or height";
  if (input.q && !input.format) return "Quality requires an output format";
  return null;
}

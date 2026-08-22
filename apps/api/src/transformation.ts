import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { config } from "./config.js";

const fields = {
  w: z.coerce.number().int().min(1).max(4096).optional(),
  h: z.coerce.number().int().min(1).max(4096).optional(),
  fit: z.enum(["cover", "contain", "fill", "inside", "outside"]).optional(),
  format: z.enum(["avif", "jpeg", "png", "webp"]).optional(),
  q: z.coerce.number().int().min(1).max(100).optional(),
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
  return query.toString();
}

export function signTransformation(
  workspaceSlug: string,
  key: string,
  input: Transformation,
) {
  return signature(workspaceSlug, key, canonicalizeTransformation(input));
}

export function transformedAssetUrl(
  workspaceSlug: string,
  key: string,
  input: Transformation,
  customDomain?: string | null,
) {
  const encodedKey = key.split("/").map(encodeURIComponent).join("/");
  const query = canonicalizeTransformation(input);
  const signed = signTransformation(workspaceSlug, key, input);
  const path = customDomain
    ? `https://${customDomain}/w/${encodedKey}`
    : `/w/${encodeURIComponent(workspaceSlug)}/${encodedKey}`;
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
  if (!input.w && !input.h && !input.format)
    return "A size or output format is required";
  if (input.fit && !input.w && !input.h)
    return "Fit requires a width or height";
  if (input.q && !input.format) return "Quality requires an output format";
  return null;
}

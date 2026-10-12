import { createHash } from "node:crypto";
import { z } from "zod";
import { vardOutputPath } from "./vard-folder-rules.js";

export const MAX_KNOWN_CONSUMERS = 200;
export const MAX_VARDS_PER_USAGE_PAGE = 100;
export const MAX_CHECKS_PER_BINDING = 1000;
export const MAX_CHECKS_PER_CONSUMER = 1000;
export const usageUuid = z.uuid().transform((value) => value.toLowerCase());
export const destinationSchema = z
  .object({
    id: usageUuid,
    label: z.string().trim().min(1).max(120),
    url: z
      .string()
      .trim()
      .max(2048)
      .refine((value) => {
        try {
          const url = new URL(value);
          return (
            ["http:", "https:"].includes(url.protocol) &&
            Boolean(url.hostname) &&
            !url.username &&
            !url.password
          );
        } catch {
          return false;
        }
      }, "Destination must be an explicit HTTP(S) URL without credentials"),
  })
  .strict();
export const targetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("asset"), assetId: usageUuid }).strict(),
  z
    .object({
      kind: z.literal("vard_output"),
      vardId: usageUuid,
      outputPath: vardOutputPath,
      assetId: usageUuid,
    })
    .strict(),
]);
export const bindingSchema = z
  .object({
    id: usageUuid,
    destinationId: usageUuid,
    mode: z.enum(["live_url", "manual_frozen", "opt_in_pr"]),
    target: targetSchema,
  })
  .strict();
export const consumerSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    kind: z.enum(["first_party", "selected_external"]),
    destinations: z.array(destinationSchema).min(1).max(20),
    bindings: z.array(bindingSchema).max(100),
  })
  .strict()
  .superRefine((value, context) => {
    const destinationIds = new Set(value.destinations.map((item) => item.id));
    if (
      destinationIds.size !== value.destinations.length ||
      new Set(value.bindings.map((item) => item.id)).size !==
        value.bindings.length
    )
      context.addIssue({
        code: "custom",
        message: "Destination and binding IDs must be unique",
      });
    if (
      value.bindings.some(
        (binding) => !destinationIds.has(binding.destinationId),
      )
    )
      context.addIssue({
        code: "custom",
        message: "Each binding must reference a declared destination",
      });
  });
export const revisionSchema = z.number().int().positive().max(2147483646);
export const replaceConsumerSchema = consumerSchema.safeExtend({
  expectedRevision: revisionSchema,
});
export const checkSchema = z
  .object({
    expectedRevision: revisionSchema,
    expectedScopeToken: z.string().regex(/^[a-f0-9]{64}$/),
    checkedAt: z.iso
      .datetime({ offset: true })
      .refine(
        (value) => Date.parse(value) <= Date.now() + 300_000,
        "Check time must not be in the future",
      ),
    reportedVersionId: usageUuid,
    commitRef: z.string().trim().min(1).max(200).optional(),
    releaseRef: z.string().trim().min(1).max(200).optional(),
    note: z.string().trim().min(1).max(2000).optional(),
  })
  .strict();
export type Destination = z.infer<typeof destinationSchema>;
export type Target = z.infer<typeof targetSchema>;
export type BindingInput = z.infer<typeof bindingSchema>;
export type StoredBinding = BindingInput & { targetLabel: string };
export type Source = {
  assetId: string;
  versionId: string;
  number: number;
  checksum: string | null;
  fingerprint: string;
};
export type EvidenceScope = {
  destination: Destination;
  target: Target;
  mode: BindingInput["mode"];
  targetLabel: string;
  outputConfiguration: string;
};
export type Evidence = {
  id: string;
  bindingId: string;
  checkedAt: Date;
  recordedAt: Date;
  actor: string;
  source: Source;
  scope: EvidenceScope;
  commitRef: string | null;
  releaseRef: string | null;
  note: string | null;
};
export function scopeToken(scope: EvidenceScope) {
  return createHash("sha256")
    .update(
      JSON.stringify([
        scope.destination.id,
        scope.destination.url,
        scope.mode,
        scope.target.kind,
        scope.target.assetId,
        scope.target.kind === "vard_output" ? scope.target.vardId : null,
        scope.target.kind === "vard_output" ? scope.target.outputPath : null,
        scope.outputConfiguration,
      ]),
    )
    .digest("hex");
}
export function bindingStatus(
  current: { resolved: boolean; source: Source | null; scopeToken: string },
  evidence: Pick<Evidence, "scope" | "source"> | null,
) {
  if (!current.resolved) return "unresolved" as const;
  if (!evidence) return "unknown" as const;
  if (current.scopeToken !== scopeToken(evidence.scope))
    return "scope_changed" as const;
  if (current.source?.fingerprint !== evidence.source.fingerprint)
    return "source_changed" as const;
  return "recorded_match" as const;
}

/** A whole-consumer prefix; each legal consumer has <= 100 bindings, so the first always fits. */
export function knownUsagePage<T extends { bindings: BindingInput[] }>(
  rows: T[],
  limit: number,
) {
  const vards = new Set<string>();
  const consumers: T[] = [];
  for (const row of rows.slice(0, limit)) {
    const additions = new Set(
      row.bindings.flatMap((binding) =>
        binding.target.kind === "vard_output" &&
        !vards.has(binding.target.vardId)
          ? [binding.target.vardId]
          : [],
      ),
    );
    if (vards.size + additions.size > MAX_VARDS_PER_USAGE_PAGE) break;
    for (const id of additions) vards.add(id);
    consumers.push(row);
  }
  return { consumers, hasMore: rows.length > consumers.length };
}

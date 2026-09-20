// A 1,000-item Vard needs a manifest plus one or more requests per file.
// This is a finite abuse bound, not a throughput guarantee.
export const workspaceKeyRateLimit = {
  enabled: true,
  maxRequests: 10_000,
  timeWindow: 60_000,
} as const;

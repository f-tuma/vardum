import { z } from "zod";

export const assetKey = z
  .string()
  .max(255)
  .regex(/^[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*$/);

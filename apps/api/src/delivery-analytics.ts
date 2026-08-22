import { lt } from "drizzle-orm";
import { deliveryEvent } from "./db/app-schema.js";
import { db } from "./db/index.js";
import { inWorkspace } from "./db/tenant.js";

export const deliveryEventRetentionDays = 90;
export const deliveryAnalyticsDays = 30;

export type DeliveryEventInput = {
  workspaceId: string;
  assetId: string;
  versionId: string;
  transformed: boolean;
  cacheHit: boolean | null;
  mimeType: string;
  bytes: number;
};

export async function recordDeliveryEvent(input: DeliveryEventInput) {
  await inWorkspace(input.workspaceId, (transaction) =>
    transaction.insert(deliveryEvent).values(input),
  );
}

export type DeliveryDay = {
  date: string;
  requests: number;
  transformed: number;
  bytes: number;
};

export function deliveryWindowStart(now = new Date()) {
  const start = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  start.setUTCDate(start.getUTCDate() - deliveryAnalyticsDays + 1);
  return start;
}

export function fillDeliveryDays(
  rows: DeliveryDay[],
  now = new Date(),
): DeliveryDay[] {
  const byDate = new Map(rows.map((row) => [row.date, row]));
  const date = deliveryWindowStart(now);
  return Array.from({ length: deliveryAnalyticsDays }, () => {
    const key = date.toISOString().slice(0, 10);
    const day = byDate.get(key) ?? {
      date: key,
      requests: 0,
      transformed: 0,
      bytes: 0,
    };
    date.setUTCDate(date.getUTCDate() + 1);
    return day;
  });
}

export async function deleteExpiredDeliveryEvents(now = new Date()) {
  const cutoff = new Date(now);
  cutoff.setUTCDate(cutoff.getUTCDate() - deliveryEventRetentionDays);
  await db.delete(deliveryEvent).where(lt(deliveryEvent.createdAt, cutoff));
}

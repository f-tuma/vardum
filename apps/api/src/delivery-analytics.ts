import { and, asc, count, gt, lt, sql, type SQL } from "drizzle-orm";
import { deliveryEvent, workspace } from "./db/app-schema.js";
import { db } from "./db/index.js";
import { inWorkspace, type Transaction } from "./db/tenant.js";

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
  // cache_hit is null for originals, so these two only ever count transformations.
  cacheHits: number;
  cacheMisses: number;
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
      cacheHits: 0,
      cacheMisses: 0,
    };
    date.setUTCDate(date.getUTCDate() + 1);
    return day;
  });
}

// One shape of delivery figures, whether the caller asks about a workspace or a
// single asset. Callers supply the filter; the window and the fill are shared.
export async function deliverySummary(
  transaction: Transaction,
  filter: SQL | undefined,
  now = new Date(),
) {
  const day = sql<string>`to_char(${deliveryEvent.createdAt} at time zone 'UTC', 'YYYY-MM-DD')`;
  const rows = await transaction
    .select({
      date: day,
      requests: count(),
      transformed:
        sql<number>`count(*) filter (where ${deliveryEvent.transformed})`.mapWith(
          Number,
        ),
      bytes: sql<number>`coalesce(sum(${deliveryEvent.bytes}), 0)`.mapWith(
        Number,
      ),
      cacheHits:
        sql<number>`count(*) filter (where ${deliveryEvent.cacheHit})`.mapWith(
          Number,
        ),
      cacheMisses:
        sql<number>`count(*) filter (where ${deliveryEvent.cacheHit} = false)`.mapWith(
          Number,
        ),
    })
    .from(deliveryEvent)
    .where(
      and(
        filter,
        sql`${deliveryEvent.createdAt} >= ${deliveryWindowStart(now)}`,
      ),
    )
    .groupBy(day)
    .orderBy(day);

  const days = fillDeliveryDays(rows, now);
  const total = (pick: (day: DeliveryDay) => number) =>
    days.reduce((sum, day) => sum + pick(day), 0);
  const hits = total((day) => day.cacheHits);
  const misses = total((day) => day.cacheMisses);
  return {
    requests30d: total((day) => day.requests),
    transformed30d: total((day) => day.transformed),
    bytes30d: total((day) => day.bytes),
    cacheHits30d: hits,
    // null, not 0: no transformation was served, so there is no ratio to report.
    cacheHitRatio: hits + misses ? hits / (hits + misses) : null,
    days,
  };
}

export async function deleteExpiredDeliveryEvents(now = new Date()) {
  const cutoff = new Date(now);
  cutoff.setUTCDate(cutoff.getUTCDate() - deliveryEventRetentionDays);
  // Traverse the global workspace directory in bounded batches. Each delete
  // gets its own transaction-local tenant context, just like ingest jobs.
  let after: string | undefined;
  while (true) {
    const workspaces = await db
      .select({ id: workspace.id })
      .from(workspace)
      .where(after === undefined ? undefined : gt(workspace.id, after))
      .orderBy(asc(workspace.id))
      .limit(100);
    for (const { id } of workspaces) {
      await inWorkspace(id, (transaction) =>
        transaction
          .delete(deliveryEvent)
          .where(lt(deliveryEvent.createdAt, cutoff)),
      );
    }
    if (workspaces.length < 100) return;
    after = workspaces.at(-1)!.id;
  }
}

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { listAuditEvents } from "./asset-api";
import {
  activityActor,
  activityLabels,
  activityTarget,
  dateTime,
} from "./workspace-overview";

const actorTypes = {
  "": "Any actor",
  user: "People",
  api_key: "API keys",
  system: "System",
} as const;

export function AuditLog({ workspaceId }: { workspaceId: string }) {
  const [action, setAction] = useState("");
  const [actorType, setActorType] = useState<keyof typeof actorTypes | "">("");
  // Keyset paging has no page numbers of its own, so the cursor of every page
  // reached so far is kept and Previous walks back down the list.
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  const [page, setPage] = useState(0);
  const audit = useQuery({
    queryKey: ["audit", workspaceId, action, actorType, cursors[page] ?? ""],
    queryFn: () =>
      listAuditEvents(workspaceId, {
        action: action || undefined,
        actorType: actorType || undefined,
        cursor: cursors[page],
      }),
    placeholderData: keepPreviousData,
  });
  const events = audit.data?.events ?? [];
  const nextCursor = audit.data?.nextCursor ?? null;

  function filter(change: () => void) {
    change();
    setCursors([undefined]);
    setPage(0);
  }

  function goNext() {
    if (!nextCursor) return;
    setCursors((current) =>
      current.length > page + 1 ? current : [...current, nextCursor],
    );
    setPage(page + 1);
  }

  return (
    <section className="settings-panel">
      <header className="outputs-header">
        <h2>┌─ ACTIVITY</h2>
        <span>
          PAGE {page + 1} // {events.length} EVENTS
        </span>
      </header>

      <div className="audit-filters">
        <label>
          Action
          <select
            value={action}
            onChange={(event) => filter(() => setAction(event.target.value))}
          >
            <option value="">Any action</option>
            {Object.entries(activityLabels).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Actor
          <select
            value={actorType}
            onChange={(event) =>
              filter(() =>
                setActorType(
                  event.target.value as keyof typeof actorTypes | "",
                ),
              )
            }
          >
            {Object.entries(actorTypes).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        {(action || actorType) && (
          <button
            type="button"
            onClick={() =>
              filter(() => {
                setAction("");
                setActorType("");
              })
            }
          >
            Clear filters
          </button>
        )}
      </div>

      {audit.isPending ? (
        <p className="settings-state">Loading audit log…</p>
      ) : audit.isError ? (
        <p className="error-strip settings-inline-error" role="alert">
          {audit.error.message}
        </p>
      ) : events.length ? (
        <ul className="audit-list">
          {events.map((event) => {
            const target = activityTarget(event);
            return (
              <li key={event.id}>
                <span className="audit-time">
                  {dateTime.format(new Date(event.createdAt))}
                </span>
                <span className="audit-action">
                  {activityLabels[event.action] ?? event.action}
                </span>
                <span className="audit-target">
                  <strong>{target.subject}</strong>
                  {target.detail && <small>{target.detail}</small>}
                </span>
                <span className="audit-actor">{activityActor(event)}</span>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="settings-state">└─ No events match these filters</p>
      )}

      {(page > 0 || nextCursor) && (
        <div className="audit-pagination">
          <button
            type="button"
            disabled={page === 0 || audit.isFetching}
            onClick={() => setPage(page - 1)}
          >
            ← Previous
          </button>
          <span>Page {page + 1}</span>
          <button
            type="button"
            disabled={!nextCursor || audit.isFetching}
            onClick={goNext}
          >
            Next →
          </button>
        </div>
      )}
    </section>
  );
}

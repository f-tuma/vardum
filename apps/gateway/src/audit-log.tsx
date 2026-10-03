import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { ChevronLeftIcon, ChevronRightIcon, HistoryIcon, TriangleAlertIcon } from "lucide-react";
import { cloneElement, useId, useState } from "react";
import { AppHeader, Page, PageHeader, PageSkeleton } from "@/components/page";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Field, FieldLabel } from "@/components/ui/field";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { dateTime, timeAgo } from "@/lib/format";
import { listAuditEvents } from "./asset-api";
import { workspaceCrumb, type WorkspaceRef } from "./workspace";
import { activityActor, activityLabels, activityLink, activityTarget } from "./workspace-overview";

const actorTypes = {
  "": "Anyone",
  user: "People",
  api_key: "API keys",
  system: "System",
} as const;

export function AuditLog({ workspace }: { workspace: WorkspaceRef }) {
  const id = useId();
  const [action, setAction] = useState("");
  const [actorType, setActorType] = useState<keyof typeof actorTypes>("");
  // Keyset paging has no page numbers of its own, so the cursor of every page
  // reached so far is kept and Previous walks back down the list.
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  const [page, setPage] = useState(0);
  const audit = useQuery({
    queryKey: ["audit", workspace.id, action, actorType, cursors[page] ?? ""],
    queryFn: () =>
      listAuditEvents(workspace.id, {
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
    setCursors((current) => (current.length > page + 1 ? current : [...current, nextCursor]));
    setPage(page + 1);
  }

  return (
    <>
      <AppHeader crumbs={[workspaceCrumb(workspace), { label: "Activity" }]} />
      <Page id="main">
        <PageHeader title="Activity" description="Everything that changed in this workspace." />
        <div className="flex flex-wrap items-end gap-3">
          <div className="w-56">
            <Field>
              <FieldLabel htmlFor={`${id}-action`}>Action</FieldLabel>
              <NativeSelect
                id={`${id}-action`}
                value={action}
                onChange={(event) => filter(() => setAction(event.target.value))}
              >
                <NativeSelectOption value="">Any action</NativeSelectOption>
                {Object.entries(activityLabels).map(([value, label]) => (
                  <NativeSelectOption key={value} value={value}>
                    {label}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </Field>
          </div>
          <div className="w-40">
            <Field>
              <FieldLabel htmlFor={`${id}-actor`}>By</FieldLabel>
              <NativeSelect
                id={`${id}-actor`}
                value={actorType}
                onChange={(event) =>
                  filter(() => setActorType(event.target.value as keyof typeof actorTypes))
                }
              >
                {Object.entries(actorTypes).map(([value, label]) => (
                  <NativeSelectOption key={value} value={value}>
                    {label}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </Field>
          </div>
          {(action || actorType) && (
            <Button
              variant="ghost"
              onClick={() =>
                filter(() => {
                  setAction("");
                  setActorType("");
                })
              }
            >
              Clear filters
            </Button>
          )}
        </div>

        {audit.isPending ? (
          <PageSkeleton />
        ) : audit.isError ? (
          <Alert variant="destructive">
            <TriangleAlertIcon />
            <AlertTitle>Activity could not load</AlertTitle>
            <AlertDescription>{audit.error.message}</AlertDescription>
          </Alert>
        ) : events.length ? (
          <div className="rounded-xl border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>When</TableHead>
                  <TableHead>Action</TableHead>
                  <TableHead>Target</TableHead>
                  <TableHead>By</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {events.map((event) => {
                  const target = activityTarget(event);
                  const link = activityLink(event, workspace.id);
                  return (
                    <TableRow key={event.id}>
                      <TableCell>
                        <time
                          dateTime={event.createdAt}
                          title={dateTime.format(new Date(event.createdAt))}
                          className="whitespace-nowrap text-muted-foreground"
                        >
                          {timeAgo(event.createdAt)}
                        </time>
                      </TableCell>
                      <TableCell>
                        <span className="font-medium">{activityLabels[event.action] ?? event.action}</span>
                      </TableCell>
                      <TableCell>
                        <span className="flex flex-col">
                          {link
                            ? cloneElement(link, { className: "w-fit underline decoration-muted-foreground/40 underline-offset-4 hover:decoration-foreground" }, target.subject)
                            : <span>{target.subject}</span>}
                          {target.detail && (
                            <span className="font-mono text-xs text-muted-foreground">{target.detail}</span>
                          )}
                        </span>
                      </TableCell>
                      <TableCell>
                        <span className="text-muted-foreground" title={event.actor.email ?? undefined}>
                          {activityActor(event)}
                        </span>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        ) : (
          <Empty variant="outline">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <HistoryIcon />
              </EmptyMedia>
              <EmptyTitle>No activity</EmptyTitle>
              <EmptyDescription>
                {action || actorType ? "Nothing matches these filters." : "Nothing has happened yet."}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}

        {(page > 0 || nextCursor) && (
          <div className="flex items-center justify-end gap-2">
            <span className="text-sm text-muted-foreground">Page {page + 1}</span>
            <Button
              variant="outline"
              size="icon"
              aria-label="Previous page"
              disabled={page === 0 || audit.isFetching}
              onClick={() => setPage(page - 1)}
            >
              <ChevronLeftIcon />
            </Button>
            <Button
              variant="outline"
              size="icon"
              aria-label="Next page"
              disabled={!nextCursor || audit.isFetching}
              onClick={goNext}
            >
              <ChevronRightIcon />
            </Button>
          </div>
        )}
      </Page>
    </>
  );
}

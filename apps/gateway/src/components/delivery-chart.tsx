import { useRef, useState, type KeyboardEvent } from "react";
import type { DeliverySummary } from "@/asset-api";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { formatBytes } from "@/lib/format";

type Day = DeliverySummary["days"][number];
type Metric = "requests" | "bytes";

const longDate = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});
const shortDate = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});
const compact = new Intl.NumberFormat(undefined, { notation: "compact" });

function utcDate(day: Day) {
  return new Date(`${day.date}T00:00:00Z`);
}

/** Rounds up to 1, 2 or 5 times a power of ten — or of 1024 for bytes. */
function niceMax(value: number, metric: Metric) {
  if (value <= 0) return metric === "bytes" ? 1024 : 4;
  let unit = 1;
  if (metric === "bytes") while (value / unit >= 1024) unit *= 1024;
  const scaled = value / unit;
  const power = 10 ** Math.floor(Math.log10(scaled));
  const step = scaled / power;
  return (step <= 1 ? 1 : step <= 2 ? 2 : step <= 5 ? 5 : 10) * power * unit;
}

function formatValue(value: number, metric: Metric) {
  return metric === "bytes" ? formatBytes(value) : compact.format(value);
}

function cacheRatio(day: Pick<Day, "cacheHits" | "cacheMisses">) {
  const total = day.cacheHits + day.cacheMisses;
  return total ? `${Math.round((day.cacheHits / total) * 100)}%` : null;
}

/** Thirty days of successful deliveries; hover or arrow through the bars for a day's figures. */
export function DeliveryChart({
  summary,
  size = "default",
}: {
  summary: DeliverySummary;
  size?: "default" | "sm";
}) {
  const [metric, setMetric] = useState<Metric>("requests");
  const [focusIndex, setFocusIndex] = useState(summary.days.length - 1);
  const bars = useRef<Array<HTMLButtonElement | null>>([]);
  const days = summary.days;
  const value = (day: Day) => (metric === "bytes" ? day.bytes : day.requests);
  const maximum = niceMax(Math.max(0, ...days.map(value)), metric);
  const peak = days.reduce<Day | undefined>(
    (best, day) => (!best || value(day) > value(best) ? day : best),
    undefined,
  );
  const empty = days.every((day) => value(day) === 0);
  const ratio = cacheRatio({
    cacheHits: summary.cacheHits30d,
    cacheMisses: days.reduce((sum, day) => sum + day.cacheMisses, 0),
  });
  const labelled = new Set([0, 7, 14, 21, days.length - 1]);

  function moveFocus(event: KeyboardEvent, index: number) {
    const next =
      event.key === "ArrowRight"
        ? Math.min(index + 1, days.length - 1)
        : event.key === "ArrowLeft"
          ? Math.max(index - 1, 0)
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? days.length - 1
              : null;
    if (next === null) return;
    event.preventDefault();
    setFocusIndex(next);
    bars.current[next]?.focus();
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col gap-0.5">
          <span className="text-2xl font-semibold tabular-nums">
            {metric === "bytes"
              ? formatBytes(summary.bytes30d)
              : summary.requests30d.toLocaleString()}
          </span>
          <span className="text-xs text-muted-foreground">
            {metric === "bytes" ? "served" : "responses"} in 30 days
            {peak && value(peak) > 0 &&
              ` · peak ${formatValue(value(peak), metric)} on ${shortDate.format(utcDate(peak))}`}
          </span>
        </div>
        <ToggleGroup
          variant="outline"
          size="sm"
          spacing={0}
          value={[metric]}
          onValueChange={(next: string[]) => {
            const chosen = next[0];
            if (chosen === "requests" || chosen === "bytes") setMetric(chosen);
          }}
          aria-label="Chart metric"
        >
          <ToggleGroupItem value="requests">Requests</ToggleGroupItem>
          <ToggleGroupItem value="bytes">Data</ToggleGroupItem>
        </ToggleGroup>
      </div>

      <div className="flex gap-2">
        <div
          aria-hidden="true"
          className="flex w-14 shrink-0 flex-col justify-between text-right text-xs text-muted-foreground tabular-nums"
        >
          <span>{formatValue(maximum, metric)}</span>
          <span>{formatValue(maximum / 2, metric)}</span>
          <span>0</span>
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <div
            data-size={size}
            className="group/chart relative data-[size=default]:h-48 data-[size=sm]:h-28"
          >
            <div aria-hidden="true" className="absolute inset-x-0 top-0 border-t border-dashed" />
            <div aria-hidden="true" className="absolute inset-x-0 top-1/2 border-t border-dashed" />
            <div aria-hidden="true" className="absolute inset-x-0 bottom-0 border-t" />
            {empty && (
              <div className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
                No deliveries in the last 30 days
              </div>
            )}
            <fieldset className="absolute inset-0 m-0 flex min-w-0 items-stretch border-0 p-0">
              <legend className="sr-only">
                Daily {metric === "bytes" ? "data served" : "responses"}, last 30 days. Use the arrow
                keys to move between days.
              </legend>
              {days.map((day, index) => {
                const total = value(day);
                const transformedShare =
                  metric === "requests" && day.requests ? day.transformed / day.requests : 0;
                const height = total ? Math.max(1.5, (total / maximum) * 100) : 0;
                const transformedHeight = height * transformedShare;
                return (
                  <Tooltip key={day.date}>
                    <TooltipTrigger
                      render={
                        <button
                          ref={(element) => {
                            bars.current[index] = element;
                          }}
                          type="button"
                          tabIndex={index === focusIndex ? 0 : -1}
                          aria-label={`${longDate.format(utcDate(day))}: ${day.requests.toLocaleString()} responses, ${formatBytes(day.bytes)}`}
                          className="group/bar flex-1 rounded-sm px-px outline-none hover:bg-muted/60 focus-visible:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
                          onFocus={() => setFocusIndex(index)}
                          onKeyDown={(event) => moveFocus(event, index)}
                        />
                      }
                    >
                      <svg
                        viewBox="0 0 10 100"
                        preserveAspectRatio="none"
                        aria-hidden="true"
                        className="size-full transition-opacity group-hover/chart:opacity-40 group-hover/bar:opacity-100 group-focus-visible/bar:opacity-100"
                      >
                        <rect
                          x={1}
                          y={100 - height}
                          width={8}
                          height={height - transformedHeight}
                          className="fill-chart-1"
                        />
                        {transformedHeight > 0 && (
                          <rect
                            x={1}
                            y={100 - transformedHeight}
                            width={8}
                            height={transformedHeight}
                            className="fill-chart-2"
                          />
                        )}
                      </svg>
                    </TooltipTrigger>
                    <TooltipContent side="top">
                      <DayDetails day={day} />
                    </TooltipContent>
                  </Tooltip>
                );
              })}
            </fieldset>
          </div>
          <div aria-hidden="true" className="flex text-xs text-muted-foreground">
            {days.map((day, index) => (
              <span key={day.date} className="flex flex-1 justify-center overflow-visible whitespace-nowrap">
                {labelled.has(index) ? shortDate.format(utcDate(day)) : ""}
              </span>
            ))}
          </div>
        </div>
      </div>

      {metric === "requests" && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <span className="size-2.5 rounded-sm bg-chart-1" />
            Original files
          </span>
          <span className="flex items-center gap-1.5">
            <span className="size-2.5 rounded-sm bg-chart-2" />
            Transformed ({summary.transformed30d.toLocaleString()})
          </span>
          {ratio && <span>Transform cache hits {ratio}</span>}
        </div>
      )}
    </div>
  );
}

function DayDetails({ day }: { day: Day }) {
  const ratio = cacheRatio(day);
  const rows: Array<[string, string, ("original" | "transformed")?]> = [
    ["Original", (day.requests - day.transformed).toLocaleString(), "original"],
    ["Transformed", day.transformed.toLocaleString(), "transformed"],
    ["Data served", formatBytes(day.bytes)],
    ...(ratio ? ([["Cache hits", ratio]] as Array<[string, string]>) : []),
  ];
  return (
    <div className="flex min-w-40 flex-col gap-1.5 py-0.5">
      <span className="font-medium">{longDate.format(utcDate(day))}</span>
      {day.requests ? (
        <dl className="flex flex-col gap-1">
          {rows.map(([label, value, swatch]) => (
            <div key={label} className="flex items-center justify-between gap-4">
              <dt className="flex items-center gap-1.5 opacity-70">
                {swatch === "original" && <span className="size-2 rounded-sm bg-chart-1" />}
                {swatch === "transformed" && <span className="size-2 rounded-sm bg-chart-2" />}
                {label}
              </dt>
              <dd className="font-medium tabular-nums">{value}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <span className="opacity-70">No deliveries</span>
      )}
    </div>
  );
}

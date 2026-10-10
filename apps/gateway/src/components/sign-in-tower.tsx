import { TOWER_ROWS, type TowerTone } from "@/components/sign-in-tower-data";

const toneClass: Record<TowerTone, string> = {
  dim: "text-muted-foreground/35",
  line: "text-muted-foreground",
  violet: "text-chart-1",
  violetBright: "text-brand",
};

/** The site's hero tower as one still character grid. Decorative. */
export function SignInTower() {
  return (
    <pre aria-hidden="true" className="m-0 font-mono text-ascii mask-fade-x select-none">
      {TOWER_ROWS.map((row, y) => (
        // Rows never reorder, so the index is a stable key.
        // oxlint-disable-next-line react/no-array-index-key
        <div key={y}>
          {row.map(([text, tone], x) => (
            // oxlint-disable-next-line react/no-array-index-key
            <span key={x} className={toneClass[tone]}>
              {text}
            </span>
          ))}
        </div>
      ))}
    </pre>
  );
}

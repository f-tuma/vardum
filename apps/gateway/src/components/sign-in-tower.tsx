import { TOWER_ROWS, type TowerTone } from "@/components/sign-in-tower-data";

const toneClass: Record<TowerTone, string> = {
  dim: "text-tower-dim",
  line: "text-tower-line",
  text: "text-tower-text",
  accent: "text-tower-accent",
  accentBright: "text-tower-accent-bright",
  ok: "text-tower-ok",
  okDim: "text-tower-ok-dim",
  warn: "text-tower-warn",
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

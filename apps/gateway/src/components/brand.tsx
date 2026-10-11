/** The Vardum tower, the same strokes as the marketing site's mark. */
function TowerGlyph() {
  return (
    <svg viewBox="0 0 28 34" aria-hidden="true" className="h-5 w-4">
      <g fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="square">
        <path d="M14 3v7M14 10 6 31M14 10l8 21M9 23h10M5 31h18" />
      </g>
      <circle cx="14" cy="3" r="2.2" fill="currentColor" />
    </svg>
  );
}

export function BrandMark() {
  return (
    <span className="flex size-8 shrink-0 items-center justify-center rounded-md border bg-background text-brand">
      <TowerGlyph />
    </span>
  );
}

export function BrandLockup() {
  return (
    <span className="flex items-center gap-2.5 font-mono text-sm font-semibold tracking-widest uppercase">
      <span className="text-brand">
        <TowerGlyph />
      </span>
      Vardum
    </span>
  );
}

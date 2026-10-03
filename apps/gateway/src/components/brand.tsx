/** The Vardum tower, drawn in the current text color. */
function TowerGlyph() {
  return (
    <svg viewBox="16 4 32 52" aria-hidden="true" className="size-5">
      <path d="M32 9 27 18h3l-7 34h18l-7-34h3z" fill="currentColor" />
      <circle cx="32" cy="14" r="3" fill="currentColor" />
    </svg>
  );
}

export function BrandMark() {
  return (
    <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground">
      <TowerGlyph />
    </span>
  );
}

export function BrandLockup() {
  return (
    <span className="flex items-center gap-2 font-semibold tracking-tight">
      <BrandMark />
      Vardum
    </span>
  );
}

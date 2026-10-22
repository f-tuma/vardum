const vardumLogo = new URL("../assets/vardum-logo.svg", import.meta.url).href;

/** The canonical Vardum mark, shared by product branding and the favicon. */
function BrandGlyph() {
  return (
    <img
      src={vardumLogo}
      alt=""
      aria-hidden="true"
      width={24}
      height={24}
      className="size-6 object-contain"
    />
  );
}

export function BrandMark() {
  return (
    <span className="flex size-8 shrink-0 items-center justify-center rounded-md border bg-background text-brand">
      <BrandGlyph />
    </span>
  );
}

export function BrandLockup() {
  return (
    <span className="flex items-center gap-2.5 font-mono text-sm font-semibold tracking-widest uppercase">
      <span className="text-brand">
        <BrandGlyph />
      </span>
      Vardum
    </span>
  );
}

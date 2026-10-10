import { cn } from "cn"

// A braille spinner, the same one a terminal shows while it works: a strip of
// frames stepped through a one-glyph window, so no timer runs in JavaScript.
const FRAMES = [..."⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"]

function Spinner({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="spinner"
      role="status"
      aria-label="Loading"
      className={cn("inline-flex size-4 shrink-0 justify-center overflow-hidden font-mono text-sm leading-4", className)}
      {...props}
    >
      <span aria-hidden="true" className="flex self-start animate-braille flex-col motion-reduce:animate-none">
        {FRAMES.map((frame) => (
          <span key={frame}>{frame}</span>
        ))}
      </span>
    </span>
  )
}

export { Spinner }

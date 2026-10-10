import { cn } from "cn"

function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      className={cn("size-full animate-pulse rounded-sm bg-hatch", className)}
      {...props}
    />
  )
}

export { Skeleton }

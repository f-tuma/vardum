import { SearchIcon } from "lucide-react";
import { Fragment, type ReactElement, type ReactNode } from "react";
import { useCommandMenu } from "@/components/command-menu";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { Button } from "@/components/ui/button";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import { Separator } from "@/components/ui/separator";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Skeleton } from "@/components/ui/skeleton";

export type Crumb = { label: string; link?: ReactElement };

/** The bar above every page: where you are, and a way to jump anywhere. */
export function AppHeader({ crumbs }: { crumbs: Crumb[] }) {
  const commandMenu = useCommandMenu();
  return (
    <header className="sticky top-0 z-10 flex h-14 shrink-0 items-center gap-2 border-b bg-background px-4">
      <SidebarTrigger />
      <div className="h-4">
        <Separator orientation="vertical" />
      </div>
      <div className="min-w-0 flex-1">
        <Breadcrumb>
          <BreadcrumbList>
            {crumbs.map((crumb, index) => (
              <Fragment key={`${crumb.label}-${String(index)}`}>
                {index > 0 && <BreadcrumbSeparator />}
                <BreadcrumbItem>
                  {crumb.link && index < crumbs.length - 1 ? (
                    <BreadcrumbLink render={crumb.link}>{crumb.label}</BreadcrumbLink>
                  ) : (
                    <BreadcrumbPage>{crumb.label}</BreadcrumbPage>
                  )}
                </BreadcrumbItem>
              </Fragment>
            ))}
          </BreadcrumbList>
        </Breadcrumb>
      </div>
      {commandMenu.available && (
        <Button variant="outline" aria-label="Search" onClick={commandMenu.open}>
          <SearchIcon data-icon="inline-start" />
          <span className="hidden sm:inline">Search</span>
          <span className="hidden sm:inline-flex">
            <KbdGroup>
              <Kbd>⌘</Kbd>
              <Kbd>K</Kbd>
            </KbdGroup>
          </span>
        </Button>
      )}
    </header>
  );
}

export function Page({
  id,
  children,
}: {
  id: string;
  children: ReactNode;
}) {
  return (
    // SidebarInset is the page's <main>; this is the skip link's target.
    <div
      id={id}
      tabIndex={-1}
      className="flex min-w-0 w-full flex-1 flex-col gap-6 p-4 outline-none md:p-6"
    >
      {children}
    </div>
  );
}

export function PageHeader({
  title,
  description,
  leading,
  badge,
  actions,
}: {
  title: string;
  description?: ReactNode;
  leading?: ReactNode;
  badge?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-4">
      <div className="flex min-w-0 items-center gap-3">
        {leading}
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex min-w-0 items-center gap-2">
            <h1 className="truncate text-2xl font-semibold tracking-tight">
              {title}
            </h1>
            {badge}
          </div>
          {description && (
            <div className="truncate text-sm text-muted-foreground">
              {description}
            </div>
          )}
        </div>
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function PageSkeleton() {
  return (
    <div className="flex flex-col gap-4" aria-busy="true">
      <div className="h-8 w-48">
        <Skeleton />
      </div>
      <div className="h-40">
        <Skeleton />
      </div>
    </div>
  );
}

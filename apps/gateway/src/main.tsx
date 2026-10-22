import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { lazy, StrictMode, Suspense } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ThemeProvider } from "next-themes";
import { router } from "./router";
import "./index.css";

const queryClient = new QueryClient();
const DevAgentation = import.meta.env.DEV
  ? lazy(() =>
      import("agentation").then(({ Agentation }) => ({ default: Agentation })),
    )
  : null;

// Route edits can reload this entry module during development. Reuse the root
// so hot reload does not mount competing React trees into the same container.
const reactRoot =
  (import.meta.hot?.data.reactRoot as Root | undefined) ??
  createRoot(document.getElementById("root")!);
if (import.meta.hot) import.meta.hot.data.reactRoot = reactRoot;

reactRoot.render(
  <StrictMode>
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <RouterProvider router={router} />
          <Toaster richColors closeButton />
        </TooltipProvider>
        {DevAgentation && (
          <Suspense fallback={null}>
            <DevAgentation />
          </Suspense>
        )}
      </QueryClientProvider>
    </ThemeProvider>
  </StrictMode>,
);

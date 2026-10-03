import type { ReactNode } from "react";
import { BrandLockup } from "@/components/brand";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export function AuthLayout({
  title,
  description,
  children,
}: {
  title: string;
  description?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <main
      id="main"
      className="flex min-h-svh flex-col items-center justify-center gap-6 bg-muted p-6"
    >
      <BrandLockup />
      <div className="w-full max-w-sm">
        <Card>
          <CardHeader>
            <CardTitle>{title}</CardTitle>
            {description && <CardDescription>{description}</CardDescription>}
          </CardHeader>
          {children && <CardContent>{children}</CardContent>}
        </Card>
      </div>
    </main>
  );
}

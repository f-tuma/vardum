import type { ReactNode } from "react";
import { BrandLockup } from "@/components/brand";
import { SignInTower } from "@/components/sign-in-tower";
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
    <main id="main" className="grid min-h-svh bg-background lg:grid-cols-2">
      <div className="hidden items-center justify-center overflow-hidden border-r bg-sidebar lg:flex">
        <SignInTower />
      </div>
      <div className="flex flex-col items-center justify-center gap-6 bg-cells p-6">
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
      </div>
    </main>
  );
}

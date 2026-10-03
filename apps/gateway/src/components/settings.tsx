import type { ReactNode } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

/**
 * Settings pages share one shape: a tab per area, kept in the URL so a link
 * opens the right tab and reload keeps it.
 */
export function SettingsTabs({
  value,
  tabs,
  onValueChange,
}: {
  value: string;
  tabs: Array<{ value: string; label: string; content: ReactNode }>;
  onValueChange: (value: string) => void;
}) {
  const active = tabs.some((tab) => tab.value === value) ? value : (tabs[0]?.value ?? "");
  return (
    <Tabs value={active} onValueChange={(next) => onValueChange(String(next))}>
      <TabsList variant="line">
        {tabs.map((tab) => (
          <TabsTrigger key={tab.value} value={tab.value}>
            {tab.label}
          </TabsTrigger>
        ))}
      </TabsList>
      {tabs.map((tab) => (
        <TabsContent key={tab.value} value={tab.value} keepMounted>
          <div className="flex flex-col gap-6 pt-4">{tab.content}</div>
        </TabsContent>
      ))}
    </Tabs>
  );
}


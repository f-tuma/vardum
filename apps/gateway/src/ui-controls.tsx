import {
  createContext,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { TabGuide, type TabGuideTopic } from "./tab-guide";

const TabsContext = createContext<{ id: string; activeTab: string } | null>(
  null,
);

export function PageTabs({
  label,
  items,
  value,
  onValueChange,
  children,
}: {
  label: string;
  items: ReadonlyArray<readonly [string, string]>;
  value?: string;
  onValueChange?: (value: string) => void;
  children: ReactNode;
}) {
  const id = useId();
  const [selectedTab, setSelectedTab] = useState(items[0]?.[0] ?? "");
  const requestedTab = value ?? selectedTab;
  const activeTab = items.some(([key]) => key === requestedTab)
    ? requestedTab
    : (items[0]?.[0] ?? "");

  function selectTab(key: string) {
    if (value === undefined) setSelectedTab(key);
    onValueChange?.(key);
  }

  return (
    <TabsContext.Provider value={{ id, activeTab }}>
      <div className="page-tabs" role="tablist" aria-label={label}>
        {items.map(([key, title], index) => (
          <button
            key={key}
            id={`${id}-tab-${key}`}
            type="button"
            role="tab"
            aria-selected={activeTab === key}
            aria-controls={`${id}-panel-${key}`}
            tabIndex={activeTab === key ? 0 : -1}
            onClick={() => selectTab(key)}
            onKeyDown={(event) => {
              let next: number;
              if (event.key === "ArrowRight") next = (index + 1) % items.length;
              else if (event.key === "ArrowLeft")
                next = (index - 1 + items.length) % items.length;
              else if (event.key === "Home") next = 0;
              else if (event.key === "End") next = items.length - 1;
              else return;
              event.preventDefault();
              const nextKey = items[next]?.[0];
              if (!nextKey) return;
              selectTab(nextKey);
              document.getElementById(`${id}-tab-${nextKey}`)?.focus();
            }}
          >
            {title}
          </button>
        ))}
      </div>
      {children}
    </TabsContext.Provider>
  );
}

export function TabPanel({
  id,
  guide,
  children,
}: {
  id: string;
  guide?: TabGuideTopic;
  children: ReactNode;
}) {
  const tabs = useContext(TabsContext);
  if (!tabs) throw new Error("TabPanel must be rendered inside PageTabs");

  // Hide instead of unmounting: uncontrolled inputs and draft state survive tab changes.
  return (
    <div
      className="settings-stack tab-panel"
      id={`${tabs.id}-panel-${id}`}
      role="tabpanel"
      aria-labelledby={`${tabs.id}-tab-${id}`}
      hidden={tabs.activeTab !== id}
      tabIndex={0}
    >
      {guide && <TabGuide topic={guide} />}
      {children}
    </div>
  );
}

export function DrawerCloseButton() {
  return (
    <button
      className="drawer-close"
      type="button"
      onClick={(event) => {
        const drawer = event.currentTarget.closest("details");
        if (drawer) {
          drawer.open = false;
          drawer.querySelector("summary")?.focus();
        }
      }}
    >
      Close ×
    </button>
  );
}

export function FilterInput({
  value,
  onChange,
  label,
}: {
  value: string;
  onChange: (value: string) => void;
  label: string;
}) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <div className="filter-input">
      <span aria-hidden="true">⌕</span>
      <input
        ref={input}
        type="search"
        aria-label={label}
        placeholder={label}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") onChange("");
        }}
      />
      {value && (
        <button
          type="button"
          aria-label={`Clear ${label.toLowerCase()}`}
          onClick={() => {
            onChange("");
            input.current?.focus();
          }}
        >
          ×
        </button>
      )}
    </div>
  );
}

export function CopyButton({
  text,
  label = "Copy",
  disabled = false,
}: {
  text: string;
  label?: string;
  disabled?: boolean;
}) {
  const [status, setStatus] = useState("");
  useEffect(() => {
    if (!status) return;
    const timer = window.setTimeout(() => setStatus(""), 2500);
    return () => window.clearTimeout(timer);
  }, [status]);
  return (
    <button
      type="button"
      disabled={disabled}
      aria-live="polite"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setStatus("Copied!");
        } catch {
          setStatus("Copy failed — retry");
        }
      }}
    >
      {status || label}
    </button>
  );
}

export function useDebouncedValue<T>(value: T, delay = 200) {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setSettled(value), delay);
    return () => window.clearTimeout(timer);
  }, [value, delay]);
  return settled;
}

import { CheckIcon, CopyIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    toast.error("Copy failed");
    return false;
  }
}

function useCopied() {
  const [copied, setCopied] = useState(false);
  async function run(text: string) {
    if (!(await copy(text))) return;
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  }
  return [copied, run] as const;
}

export function CopyButton({
  text,
  label = "Copy",
  variant = "outline",
  size = "default",
  disabled = false,
}: {
  text: string;
  label?: string;
  variant?: "outline" | "secondary" | "ghost" | "default";
  size?: "default" | "sm";
  disabled?: boolean;
}) {
  const [copied, run] = useCopied();
  return (
    <Button
      type="button"
      variant={variant}
      size={size}
      disabled={disabled}
      onClick={() => void run(text)}
    >
      {copied ? <CheckIcon data-icon="inline-start" /> : <CopyIcon data-icon="inline-start" />}
      {copied ? "Copied" : label}
    </Button>
  );
}

export function CopyIconButton({
  text,
  label,
  disabled = false,
}: {
  text: string;
  label: string;
  disabled?: boolean;
}) {
  const [copied, run] = useCopied();
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={label}
            disabled={disabled}
            onClick={() => void run(text)}
          />
        }
      >
        {copied ? <CheckIcon /> : <CopyIcon />}
      </TooltipTrigger>
      <TooltipContent>{copied ? "Copied" : label}</TooltipContent>
    </Tooltip>
  );
}

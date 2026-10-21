import type { Transformation } from "@vardum/shared";
import { InfoIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

export function validOutputSafeArea(transformation: Transformation | null | undefined) {
  const pad = transformation?.pad;
  if (pad === undefined || pad === 0) return true;
  return validPadding(pad) && pad > 0 && Boolean(transformation?.format)
    && transformation?.fit === "contain"
    && [transformation?.w, transformation?.h].every((size) => Number.isInteger(size) && size! >= 1 && size! <= 4096);
}

export function OutputSafeArea({ id, transformation, onChange, disabled = false }: {
  id: string;
  transformation: Transformation | null | undefined;
  onChange: (value: number | undefined) => void;
  disabled?: boolean;
}) {
  const pad = transformation?.pad;
  const valid = validOutputSafeArea(transformation);
  const inRange = pad === undefined || validPadding(pad);
  return <Field data-disabled={disabled} data-invalid={!valid}>
    <div className="flex items-center justify-between gap-3">
      <div className="flex items-center gap-1">
        <FieldLabel htmlFor={id}>Safe area (%)</FieldLabel>
        <Tooltip>
          <TooltipTrigger render={<Button type="button" variant="ghost" size="icon-xs" aria-label="About safe area" />}><InfoIcon /></TooltipTrigger>
          <TooltipContent>Space on each side, as a percentage of the shorter canvas edge. Keeps the whole source centered without cropping. Existing transparent margins stay included.</TooltipContent>
        </Tooltip>
      </div>
      <div className="w-24 shrink-0"><Input id={id} name="pad" type="number" min={0} max={45} step={0.01} placeholder="0" value={pad ?? ""}
        disabled={disabled} aria-invalid={!valid} aria-describedby={!valid ? `${id}-error` : undefined}
        onChange={(event) => onChange(event.target.value === "" ? undefined : Number(event.target.value))} /></div>
    </div>
    {!valid ? <FieldError id={`${id}-error`}>{!inRange ? "Enter 0 to 45, with at most two decimal places." : "Set both width and height to define the canvas."}</FieldError> : null}
  </Field>;
}

function validPadding(value: number) {
  return Number.isFinite(value) && value >= 0 && value <= 45
    && Math.abs(value * 100 - Math.round(value * 100)) < 1e-8;
}

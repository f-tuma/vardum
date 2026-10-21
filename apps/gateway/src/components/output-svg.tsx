import type { Transformation } from "@vardum/shared";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";

export function outputMime(format: NonNullable<Transformation["format"]>) {
  return format === "svg" ? "image/svg+xml" : `image/${format}`;
}

/** Optional vector settings stay out of the ordinary raster workflow. */
export function OutputSvg({ id, value, onChange, disabled = false }: {
  id: string;
  value: Transformation;
  onChange: (patch: Partial<Transformation>) => void;
  disabled?: boolean;
}) {
  const [expanded, setExpanded] = useState(Boolean(value.layer || value.darkLayer));
  return <>
    <Button type="button" variant="ghost" size="sm" aria-expanded={expanded} aria-controls={`${id}-settings`}
      onClick={() => setExpanded(!expanded)}>SVG layers and theme</Button>
    {expanded ? <FieldGroup id={`${id}-settings`}>
      <Field data-disabled={disabled}>
        <FieldLabel htmlFor={`${id}-layer`}>Layer ID</FieldLabel>
        <Input id={`${id}-layer`} value={value.layer ?? ""} disabled={disabled} maxLength={64}
          pattern="[A-Za-z_][A-Za-z0-9_.-]{0,63}" placeholder="Whole artwork" spellCheck={false}
          onChange={(event) => onChange({ layer: event.target.value || undefined })} />
        <FieldDescription>Use a group ID from the source SVG. The canvas and parent transforms are kept.</FieldDescription>
      </Field>
      {value.format === "svg" ? <>
        <Field orientation="horizontal" data-disabled={disabled}>
          <FieldLabel htmlFor={`${id}-adaptive`}>Adapt a layer in dark mode</FieldLabel>
          <Switch id={`${id}-adaptive`} checked={value.darkColor !== undefined} disabled={disabled}
            onCheckedChange={(checked) => onChange({ darkLayer: checked ? value.layer ?? "" : undefined,
              darkColor: checked ? "#ffffff" : undefined })} />
        </Field>
        {value.darkColor !== undefined ? <div className="grid grid-cols-2 gap-3">
          <Field data-disabled={disabled}><FieldLabel htmlFor={`${id}-dark-layer`}>Adaptive layer ID</FieldLabel>
            <Input id={`${id}-dark-layer`} value={value.darkLayer ?? ""} required maxLength={64}
              pattern="[A-Za-z_][A-Za-z0-9_.-]{0,63}" disabled={disabled} spellCheck={false}
              onChange={(event) => onChange({ darkLayer: event.target.value })} /></Field>
          <Field data-disabled={disabled}><FieldLabel htmlFor={`${id}-dark-color`}>Dark-mode color</FieldLabel>
            <Input id={`${id}-dark-color`} value={value.darkColor} required pattern="#[0-9a-fA-F]{6}" maxLength={7}
              disabled={disabled} spellCheck={false} onChange={(event) => onChange({ darkColor: event.target.value })} /></Field>
        </div> : null}
      </> : null}
    </FieldGroup> : null}
  </>;
}

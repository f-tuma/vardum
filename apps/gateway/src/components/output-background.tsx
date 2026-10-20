import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";

export function validOutputBackground(value: string | undefined) {
  return value === undefined || /^#[0-9a-f]{6}$/i.test(value);
}

export function OutputBackground({ id, value, onChange, disabled = false }: {
  id: string;
  value: string | undefined;
  onChange: (value: string | undefined) => void;
  disabled?: boolean;
}) {
  const valid = validOutputBackground(value);
  return <Field data-disabled={disabled} data-invalid={!valid}>
    <div className="flex items-center justify-between gap-3">
      <FieldLabel htmlFor={`${id}-enabled`} title="Composite onto a solid color and remove transparency from this output. The source stays unchanged.">Solid background</FieldLabel>
      <Switch id={`${id}-enabled`} checked={value !== undefined} disabled={disabled}
        onCheckedChange={(checked) => onChange(checked ? "#ffffff" : undefined)} />
    </div>
    {value !== undefined ? <div className="flex min-w-0 gap-2">
      <div className="w-10 shrink-0"><Input type="color" aria-label="Background color" disabled={disabled}
        value={valid ? value : "#ffffff"} onChange={(event) => onChange(event.target.value)} /></div>
      <Input aria-label="Background hex color" value={value} required pattern="#[0-9a-fA-F]{6}" maxLength={7}
        placeholder="#ffffff" spellCheck={false} disabled={disabled} aria-invalid={!valid}
        onChange={(event) => onChange(event.target.value)} />
    </div> : null}
    {!valid ? <FieldError>Enter a six-digit hex color, for example #ffffff.</FieldError> : null}
  </Field>;
}

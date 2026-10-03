import { useEffect, useId, useRef } from "react";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { slugify } from "@/lib/format";

/** Shared creation fields; native form reset also restores automatic slugs. */
export function NameSlugFields({ autoFocus = false }: { autoFocus?: boolean }) {
  const id = useId();
  const slugRef = useRef<HTMLInputElement>(null);
  const manuallyEdited = useRef(false);

  useEffect(() => {
    const form = slugRef.current?.form;
    const reset = () => {
      manuallyEdited.current = false;
    };
    form?.addEventListener("reset", reset);
    return () => form?.removeEventListener("reset", reset);
  }, []);

  return (
    <>
      <Field>
        <FieldLabel htmlFor={`${id}-name`}>Name</FieldLabel>
        <Input
          id={`${id}-name`}
          name="name"
          autoFocus={autoFocus}
          autoComplete="off"
          required
          onChange={(event) => {
            if (!manuallyEdited.current && slugRef.current) {
              slugRef.current.value = slugify(event.currentTarget.value);
            }
          }}
        />
      </Field>
      <Field>
        <FieldLabel htmlFor={`${id}-slug`}>Slug</FieldLabel>
        <Input
          ref={slugRef}
          id={`${id}-slug`}
          name="slug"
          pattern="[a-z0-9-]+"
          autoComplete="off"
          spellCheck={false}
          required
          onChange={(event) => {
            manuallyEdited.current = event.currentTarget.value !== "";
          }}
        />
        <FieldDescription>Used in URLs. Cannot be changed later.</FieldDescription>
      </Field>
    </>
  );
}

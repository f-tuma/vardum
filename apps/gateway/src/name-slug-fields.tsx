import { useEffect, useRef } from "react";

function slugify(name: string) {
  return name
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Shared creation fields; native form reset also restores automatic slugs. */
export function NameSlugFields({ autoFocus = false }: { autoFocus?: boolean }) {
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
      <label>
        Name
        <input
          name="name"
          autoFocus={autoFocus}
          required
          onChange={(event) => {
            if (!manuallyEdited.current && slugRef.current) {
              slugRef.current.value = slugify(event.currentTarget.value);
            }
          }}
        />
      </label>
      <label>
        Slug
        <input
          ref={slugRef}
          name="slug"
          pattern="[a-z0-9-]+"
          required
          onChange={(event) => {
            manuallyEdited.current = event.currentTarget.value !== "";
          }}
        />
      </label>
    </>
  );
}

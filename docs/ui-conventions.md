# Gateway UI conventions

The gateway uses shadcn/ui's compact Nova style with Base UI primitives, Tailwind CSS v4, Lucide icons, and Geist fonts. `apps/gateway/components.json` defines the registry and import aliases. The components in `apps/gateway/src/components/ui` are local source; update them deliberately and retain the app's existing variants.

## Tokens and layout

- `apps/gateway/src/index.css` owns the light and dark semantic tokens. Use `background`, `foreground`, `card`, `popover`, `primary`, `muted`, `destructive`, `success`, and `warning` tokens instead of page-specific colors. Keep theme changes in that file.
- Prefer component variants for appearance. Use caller `className` for width, alignment, spacing, and responsive layout; shared visual changes belong in the component or token definitions.
- Keep the compact control sizes and existing page spacing. Use `AppHeader`, `Page`, and `PageHeader` for the shared page shape, and `flex`/`grid` with `gap` for layout.
- Allow flex and grid content to shrink with `min-w-0`. Confine wide tables or tab lists to local scroll containers so the page stays within a narrow viewport.

## Components and composition

- Use the existing Button, Card, Field, Input, NativeSelect, Checkbox, Switch, Tabs, Dialog, AlertDialog, DropdownMenu, Empty, Skeleton, and feedback components before creating equivalents.
- Use Base UI's `render` prop for link or custom trigger composition. Do not apply Radix's `asChild` patterns to these components.
- Keep item/group relationships intact: tabs belong in TabsList, commands in CommandGroup, and menu items in DropdownMenuGroup. Use Lucide icons with `data-icon="inline-start"` or `inline-end` in buttons; the component supplies icon sizing.
- `SettingsTabs` supplies real tabs and panels for settings screens. Keep mounted panels where draft preservation is needed. The shared TabsList wrapper scrolls horizontally, reserves space for focus rings and the line indicator, and retains Base UI arrow, Home, End, Enter, and Space behavior. Forward orientation to the primitive for vertical tabs.
- Use Empty for a successful request with no data, Skeleton or Spinner for loading, Alert or an existing announced error component for failures, and sonner for transient action feedback. Offer Retry for recoverable request failures. Keep disabled actions disabled while their request is pending.

## Forms and validation

- Compose forms with FieldGroup and Field. Associate FieldLabel with the control's `id`; use FieldSet and FieldLegend for related controls. Use native `required`, `type`, `pattern`, and `minLength` constraints where appropriate.
- For an actual field error, set `data-invalid` on Field and `aria-invalid` on its control. Give FieldError an `id` and include it in the control's `aria-describedby`, alongside any persistent helper description. Clear or revalidate the field error when its value changes.
- Keep relationship validation such as password confirmation separate from general server errors. A mismatched password can describe both participating controls; an unrelated network or authentication failure must not mark every input invalid.
- Preserve entered values on failed requests. Disable submission during pending work and provide a visible, accessible loading indication. Keep labels visible; a placeholder alone is not a label.

## Dialogs and accessibility

- Every Dialog, AlertDialog, and Sheet needs its title and an appropriate description. A title may be visually hidden when the purpose is already clear. Let the primitive manage focus trapping, Escape, and focus return.
- DialogContent's `default`, `lg`, and `xl` variants share a viewport height limit and vertical scrolling. Choose the size variant instead of repeating dialog width classes. On short screens, all form fields and footer actions must remain reachable by scrolling.
- The command palette keeps its top-third desktop placement, so it uses the remaining viewport height as its limit. Its list scrolls inside the dialog. Asset search failures are announced and have a keyboard-selectable Retry command; local page and workspace matches remain usable.
- Icon-only actions need an accessible name at every breakpoint. Keep the header Search button's `aria-label` even when its visible text is hidden. Retain visible keyboard focus, a skip target, and sufficient contrast in both themes.

## Deliberate exceptions and remaining work

- Charts, file previews, asset thumbnails and file-selection tiles use domain-specific markup inside the shared page and card structure. They do not need a generic component replacement merely to use the library.
- Command uses cmdk within a Base UI Dialog; its input is the cmdk input inside InputGroup so filtering and keyboard selection retain cmdk's behavior.
- Some existing operation and request errors use FieldError at the form or page level. It announces them through its alert role; do not infer that a particular input is invalid without field-specific validation evidence.
- Existing setup examples, CLI instructions and domain-verification guidance serve product tasks. This migration does not add a general guide area or change those flows.
- This document covers UI composition. Asset query invalidation and API/security hardening are separate work; UI migration completion does not establish those behaviors.

## Verification for UI changes

Run the gateway lint, typecheck, tests, and production build appropriate to the change. Check affected flows at desktop and narrow mobile widths, including short landscape viewports, in both themes when colors change. Exercise keyboard entry and exit, tab focus and activation, meaningful loading/empty/error/disabled states, and form error associations. Verify long dialogs by reaching their first field and footer through the dialog's own scroll area.

Use the project's package runner to inspect component documentation before changing a component: `pnpm dlx shadcn@latest info --json` and `pnpm dlx shadcn@latest docs <component>`. Fetch the returned official docs and review a dry run or diff before updating local component source.

# Musubi: one logo source, output-specific uses

Inventory date: 2026-10-20. This is a migration plan, not a record of completed production changes.

The background transformation supplies one missing operation: opaque raster outputs from a transparent original. Existing uses still inherit source visibility and follow its latest ready version. Vard manual mappings can use the same source with independent transforms; live library-use bindings remain VARD-102.

## Current consumers and required operations

| Use | Current source key | Requirements beyond original logo |
| --- | --- | --- |
| Marketing navigation/footer | `brand/website/logo` | Transparent 48×48 SVG, cream/red |
| Marketing favicon | `brand/website/favicon` | Adaptive SVG neutral color; keep internal light/dark CSS |
| App favicon | `brand/web-app/favicon` | Transparent 48×48 SVG, currently cream/red |
| App touch/notification icon | `brand/web-app/apple-touch-icon` | Opaque 180×180 PNG; explicit artwork scale/background |
| Marketing and app OG | `brand/web-app/og` | Shared 1200×630 composition with logo/text/background |
| App brand masks | `brand/web-app/logo-ink`, `logo-accent` | Separate SVG arm masks; retain color controlled by the app theme |
| Mobile base/dark icon | `brand/mobile/icon` | 1024×1024 PNG, #050507 background, centered 700×502 cream/red mark |
| Mobile light icon | `brand/mobile/icon-light.png` | Same size, #e8e4d9 background, ink/red mark |
| Android foreground | `brand/mobile/android-icon-foreground.png` | Transparent 1024×1024, centered 440×316 ink/red mark |
| Android background | `brand/mobile/android-icon-background.png` | Solid #e8e4d9 1024×1024 canvas |
| Android monochrome | `brand/mobile/android-icon-monochrome.png` | Centered 626×450 monochrome mark on transparent canvas |
| Dark/light splash | `brand/mobile/splash-icon.png`, `splash-icon-light.png` | Transparent 1024×1024, centered 700×502 mark; neutral color differs |
| Expo favicon | `brand/mobile/favicon.png` | Transparent 48×48 PNG, cream/red |
| Email logo | Bundled `packages/emails/assets/logo.png` | Transparent 128×128 PNG, offline/self-hosted CID attachment |

Brand consumers are in `musubi-web/src/brand.ts`, `Musubi/apps/web/src/brand.ts`, `BrandMark.tsx`, `push/source.ts`, `apps/client/app.config.ts` and `packages/emails/src/brand.ts`. Mobile's eight current sources are private and frozen through `apps/client/assets/vardum.json`, `.vardum.lock` and its CI restoration check. `brand/website/og` and existing immutable URLs remain historical; do not delete them.

## Migration boundaries

Background + dimensions + format cannot reproduce color changes, safe-area scale, monochrome masks or OG composition. The next source model must retain named vector layers and explicit palettes, mark size/position on the final canvas, and a composition recipe. Do not flatten the adaptive favicon or replace theme-controlled arm masks with whole-logo bitmaps.

A source/use key cannot be overwritten or rebound today. To avoid breaking old frozen/immutable URLs, create new use paths and deliberately update consumers; retain the old sources and histories. Preserving occupied stable paths through a source-to-use conversion needs its own model and recovery design, not delete/recreate.

One source has one visibility policy. Public website logo uses cannot expose a private mobile source. Prefer an explicitly public branding master for public consumers; private mobile manifest/lock controls and any truly private artwork remain separate. A private Vard does not make a public source confidential.

## Safe sequence

1. Ship VARD-105 and deploy all serving API nodes before using `bg`.
2. Choose and preview the transparent vector master; retain existing artwork as rollback references.
3. Create new linked paths for truly equivalent whole-logo uses. Preview at their actual display sizes and verify expected MIME, alpha, privacy, URL redirects and propagation after a ready version update.
4. For mobile, use explicit manual mappings to the master (not a copied library-use setting presented as a live binding). Perform normal/frozen restore in an isolated Musubi copy; review output pixel differences before committing a new lock.
5. Add palette, canvas/safe-area and layer/composition recipes before migrating the remaining light/dark, adaptive, mask and OG roles. Keep the user-facing look unchanged until the replacement is reviewed.
6. Repoint actual consumer references only after the resulting files and production URLs are verified. Keep old sources/versions; no automatic deletion or same-key replacement.

VARD-106 tracks the data migration and actual consumer adoption. The generic background change alone does not complete it.

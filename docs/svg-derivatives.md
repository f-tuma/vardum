# Bounded SVG derivatives

An explicit `format: "svg"` produces vector output from an SVG source. It retains
paths, shapes, group transforms, default colors and the source canvas; it does not
embed raster images. A use or Vard can select one existing group with `layer` and
retain matching registration between separately delivered logo arms.

```json
{ "format": "svg", "w": 48, "h": 48, "fit": "contain", "layer": "neutral-arm" }
```

Selection keeps every ancestor transform and presentation attribute along the
selected group's path. It drops siblings and keeps the complete source viewBox.
It never trims to artwork bounds. Selecting `neutral-arm` and `accent-arm` from
the same 48×48 master therefore produces two aligned 48×48 outputs.

SVG output supports `contain` only; it defaults to `contain` when size is supplied.
Both dimensions create that exact centered canvas. One dimension derives the
other from the source's intrinsic aspect ratio. Without dimensions, the source
canvas is retained. The original viewport-to-viewBox mapping, including any
existing letterboxing, is preserved inside a separate contain wrapper. `bg` adds an opaque background rectangle; omitting it retains
transparency. `pad` uses the same whole-source bounds and integer pixel inset as
[raster padding](output-padding.md). `q` is rejected for SVG output.

`layer` can also precede raster encoding, for example a PNG from one arm. SVG
output, group selection and adaptive color fields reject raster sources with
`422`, including when a source changes type. `image/svg+xml` and `.svg` are used
consistently by delivery and manifests.

## Adaptive favicon colors

A pair of optional fields changes only filled shapes in a selected existing group
when the browser prefers a dark color scheme:

```json
{ "format": "svg", "w": 48, "h": 48, "darkLayer": "neutral-arm", "darkColor": "#e8e4d9" }
```

The default palette remains in the geometry. The renderer emits fixed inline CSS
under `@media (prefers-color-scheme: dark)` and assigns its own fixed class only to
filled shapes in `darkLayer`. A shape whose inherited fill is `none` stays unfilled;
strokes and sibling groups retain their colors. Both fields are required together,
and the adaptive group must exist inside the selected output. Colors accept only
six-digit `#rrggbb` values, normalized to lowercase. IDs accept
`[A-Za-z_][A-Za-z0-9_.-]{0,63}` and identify a `g` element.

Delivery keeps the existing SVG sandbox, `nosniff` and restrictive CSP. Inline CSS
is allowed for the generated media rule. Source CSS is never copied into a new
SVG derivative.

## Supported source dialect and limits

The strict [saxes XML parser](https://github.com/lddubeau/saxes) validates XML and
namespaces before a separate element/attribute/value allowlist is serialized.
The supported passive subset is UTF-8 XML 1.0 containing a single SVG namespace
root and `g`, `path`, `rect`, `circle`, `ellipse`, `line`, `polyline`, `polygon`.
Basic fill/stroke colors, fill rules, opacity, line styles, numeric geometry and
matrix/translate/scale/rotate/skew transforms are supported. The root needs a
positive numeric intrinsic width/height or a positive viewBox. Length units,
percentages and external references are unsupported.

Scripts, event handlers, source styles/classes, text/fonts, images, links, use,
definitions, clipping/filter/mask resources, animation, foreign namespaces,
DOCTYPE/entity declarations, processing instructions and CDATA are rejected.
Malformed XML, duplicate IDs and missing selected groups return `422`; there is
no fallback that silently includes an unwanted group or rasterizes vector output.
XML comments and the supported XML declaration are discarded from derivatives.

Limits are 512 KiB source bytes, 2048 elements, depth 32, 24 attributes per element,
128 KiB per attribute, 32 transforms per attribute and 32,768 numeric parameters
per path/point attribute. Numeric magnitudes are at most 10,000,000; source canvas
sides are at most 16,384 and its area at most 100 million pixels. The configured
output pixel budget applies to the complete final canvas. Vector output is capped
at 1 MiB. Existing transformation admission, source reads, timeout and storage
budgets also apply.

The subset is intentionally small. Export a passive geometric master for these
recipes. SVG delivery with no transformation continues returning the exact
original bytes, including its original styles and encoding, through the existing
sandboxed original-delivery path.

## Raster canvas admission

SVG raster requests check the loader canvas, the resized canvas before cropping,
and the final output before rendering. This also applies after `layer` selection.
The source and intermediate canvas budget is 100 million pixels; a loaded SVG
side must not exceed 32,767 pixels. The final canvas uses the configured output
pixel limit, including contain bars and safe-area padding. A small cropped output
does not make a very large intermediate canvas safe.

Sharp's input metadata rounds SVG dimensions to integers, while its SVG loader
can scale the original fractional dimensions. Admission therefore uses conservative
bounds around the unknown fractions. A request can return `422` even when its
actual output would fit a very tight limit: for example, a 1.1×10 SVG requested at
height 128 renders 14×128, but metadata 1×10 alone cannot prove that exact boundary.
The error asks for smaller dimensions or a re-exported SVG canvas. Legacy
background rendering disables loader scaling and retains its separate geometry.
These bounds follow the pinned
[Sharp resize pipeline](https://github.com/lovell/sharp/blob/v0.35.5/src/pipeline.cc)
and [shrink calculation](https://github.com/lovell/sharp/blob/v0.35.5/src/common.cc).

Admission does not change the source, resize parameters, encoders, signed URLs,
fingerprints or derivative keys. Accepted requests retain the same rendered bytes.
Existing stored derivatives are served before these geometry checks; an unsafe
cache miss fails without replacing a retained output or updating a frozen lock.
The bounds cover canvas pixels, not arbitrary SVG document complexity or all native
decoder memory use. Existing input-byte, concurrency and deadline limits remain
necessary.

## Identity and retained output

For a new SVG-to-raster recipe with an opaque background, explicitly select
`render: "v2"`:

```json
{ "format": "png", "w": 1024, "h": 1024, "fit": "contain", "pad": 12.8, "bg": "#050507", "render": "v2" }
```

This rasterizes the vector at the requested size with transparent padding, then
composites the background and encodes in a separate stage. A lossless raw canvas
keeps alpha and geometry between stages. It avoids enlarging a native-size SVG
raster after flattening, which can blur edges and expand visible artwork bounds.
Whole-source bounds and existing transparent margins are retained. All raster
formats and resize fits remain available; the existing positive-padding rules
still apply. `render: "v2"` requires an SVG source, explicit raster format and
`bg`; it is rejected for SVG output, raster sources and animated raster content.
Regular SVG rasterization retains its current source support. Only recipes with
`layer` use the passive geometric subset described above.

The field has no schema default. Its explicit presence is signed and changes
the derivative key and Vard fingerprint. Omitting it retains the exact legacy
canonical string, cache key and renderer, including for existing background
recipes. Opening or saving an existing recipe does not upgrade it. The dashboard
automatically includes v2 for newly authored SVG background recipes in transform
previews, linked uses and Vard outputs; it has no separate renderer control.
Upgrade a saved recipe deliberately through the API/MCP by adding the field.
Captured legacy URLs and frozen locks continue selecting the legacy recipe.

Both stages share the transformation deadline and admission slot; the complete
raw canvas is bounded by the existing output pixel limit. Source read and input
pixel limits still apply. Deploy the API to every serving instance before
authoring v2 recipes, since older strict schemas reject `render`.

`layer`, `darkLayer`, `darkColor`, SVG format and positive decimal padding all
participate in canonical signing, derivative cache identity and Vard fingerprints.
SVG canonical queries omit quality. Existing raster canonical queries and zero
padding retain their exact previous identity and pipeline when `render` is omitted.

Captured URLs and frozen locks retain their selected parameters. The existing
[derived-output preservation contract](adr/0001-derived-output-preservation.md)
still applies: retain stored outputs; regeneration after cache loss is not a
historical byte-reconstruction guarantee. Deploy the new API to every instance
before saving SVG recipes, since older APIs reject these strict fields.

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

## Identity and retained output

`layer`, `darkLayer`, `darkColor`, SVG format and positive decimal padding all
participate in canonical signing, derivative cache identity and Vard fingerprints.
SVG canonical queries omit quality. Existing raster canonical queries and zero
padding retain their exact previous identity and pipeline.

Captured URLs and frozen locks retain their selected parameters. The existing
[derived-output preservation contract](adr/0001-derived-output-preservation.md)
still applies: retain stored outputs; regeneration after cache loss is not a
historical byte-reconstruction guarantee. Deploy the new API to every instance
before saving SVG recipes, since older APIs reject these strict fields.

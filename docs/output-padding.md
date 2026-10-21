# Output padding

An optional `transformation.pad` adds centered space around an image without
changing the final output dimensions. It is a number from 0 to 45 with at most two decimal places: the percent
of the shorter final side reserved on **each** edge. For positive padding,
provide both `w` and `h`, an explicit `format`, and `fit: "contain"`.

For example, a transparent SVG logo can produce an opaque 1024×1024 app icon:

```json
{ "w": 1024, "h": 1024, "fit": "contain", "format": "png", "bg": "#050507", "pad": 16, "render": "v2" }
```

Values such as `12.80`, `26.57` and `16.70` reserve exactly 131, 272 and
171 pixels per edge on a 1024×1024 canvas. Trailing zeroes normalize in signed
queries (`12.80` becomes `12.8`); existing integer recipes keep their identity.

This reserves `floor(1024 × 16 / 100) = 163` pixels on every edge, then fits the
complete source into a centered 698×698 inner box while preserving its aspect
ratio. A wide logo therefore has more space above and below. Padding uses the
source's existing bounds, including transparent margins; it does not trim or
detect artwork. It does not guarantee compliance with any platform's icon mask
or shaped safe area. Choose the amount using the output preview.

The same pixel inset applies to all four edges on rectangular canvases too:
100×80 at 25% reserves 20 pixels on every edge and a 60×40 inner box. Fractional
pixels round down. Tiny outputs may have a zero-pixel inset; the inner box always
remains at least one pixel wide and high. No source is cropped or stretched.

With `bg`, transparent pixels and padding use that opaque color. Omit `bg` for
transparent padding in PNG, WebP, AVIF or SVG. JPEG cannot preserve transparency; choose
an explicit background for predictable opaque icons. Animated output retains
per-frame geometry and timing for formats that support animation. SVG output
keeps vector geometry; see [bounded SVG derivatives](svg-derivatives.md).
The example selects v2 for an SVG source so its vector is rasterized at the final
inner size before background compositing. Omit `render` for raster sources and
transparent or SVG output. Existing recipes retain their renderer when opened
or saved; add v2 explicitly to upgrade an existing SVG background recipe.

Padding is available on linked library uses, Vard manual outputs and source
transform previews. It changes only the output recipe; the source bytes and
version history are retained. It does not create a live binding from Vard items
to library-use settings.

Positive `pad` participates in the signed query, derivative cache key and Vard
fingerprint. Captured immutable URLs and schema-2 frozen locks keep their selected
padding and retained bytes after a later recipe edit. Omitted padding and `pad: 0`
use exactly the existing canonical identity and rendering pipeline. No cache
namespace, manifest schema or database migration is needed. Output pixel limits
count the complete final canvas on every animation frame.

Deploy the API update to every serving instance before saving padded recipes;
older API versions reject the new strict query/body field. Existing CLI clients
can pull and freeze these outputs using their current signed-URL protocol.

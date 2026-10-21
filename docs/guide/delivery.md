# Delivery

Use files straight from Vardum on a website, without a repository.

## Stable and immutable URLs

```text
/w/acme/site/hero              stable
  │
  └─ 302 ─> /w/acme/__v/<id>/site/hero
                               immutable
```

- The stable URL follows the current version: upload or restore, and it moves.
- Public redirects are cacheable for 60 seconds.
- Link to an immutable URL to keep one exact version.

## Variants

Add parameters and a signature:

```text
/w/acme/site/hero
  ?w=800&fit=inside
  &format=webp&q=80
  &sig=...
```

| Parameter | Values |
| --- | --- |
| `w`, `h` | 1–4096 px |
| `fit` | `cover` `contain` `fill` `inside` `outside` (default `inside`, SVG output: `contain` only) |
| `format` | `avif` `jpeg` `png` `webp` `svg` (SVG source defaults to `png` when format is omitted) |
| `q` | 1–100, default 80, needs a raster `format` |
| `bg` | Opaque six-digit hex color; needs `format` |
| `pad` | 0–45%, at most two decimal places per edge; positive values require `w`, `h`, `format`, `fit=contain` |
| `layer` | Select one geometric SVG group by bounded XML ID |
| `darkLayer`, `darkColor` | SVG group and six-digit fill color for dark mode, together; needs `format=svg` |
| `sig` | Required |

- Change any value without re-signing and you get `403`.
- Get signed URLs from the asset page (**Copy transform URL**) or a Vard variant.
- Rendered on first request, then served from the bucket (`derived/`).
- If that stored variant is lost, the installed renderer regenerates it. The same
  source version and parameters can then produce different encoded bytes; frozen
  pull rejects a checksum mismatch, even with `--force`.
- Keep stored variants; do not configure automatic derived-cache deletion before
  an accepted retention/reconstruction model. See the
  [preservation contract](../adr/0001-derived-output-preservation.md).
- Rotating `TRANSFORM_SECRET` breaks every signed URL, including locked ones.
- Video has no variants.
- SVG output and group selection require an SVG source. Unsupported source markup
  or missing groups return `422`; [bounded SVG derivatives](../svg-derivatives.md)
  describes the supported dialect. A URL without a transformation delivers the
  original SVG bytes and behavior unchanged.

## Private files

- Every request needs workspace read access: redirects, `HEAD` and ranges too.
- A signature is not access.
- Private responses are never cacheable.
- Making a file private cannot recall copies already downloaded or cached.
- Keep the bucket itself private, or it bypasses all of this.

## Custom domains

```text
assets.example.com/w/site/hero
```

1. The instance sets `CUSTOM_DOMAIN_TARGET`.
2. A workspace owner adds the domain in **Settings**.
3. Create the TXT and CNAME records shown there.
4. Verified by TXT, so Cloudflare-proxied domains work too.

- On your own domain the URL has no workspace slug.
- TLS stays with Cloudflare or your proxy; it must pass `Host` through.
- `/w/<workspace>/<key>` keeps working.

## Analytics

- Overview: successful `GET`s over 30 days, originals and variants, plus the
  share of variants served from the bucket.
- Raw events are kept for 90 days.

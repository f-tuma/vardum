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
| `fit` | `cover` `contain` `fill` `inside` `outside` (default `inside`) |
| `format` | `avif` `jpeg` `png` `webp` (SVG defaults to `png`) |
| `q` | 1–100, default 80, needs `format` |
| `sig` | Required |

- Change any value without re-signing and you get `403`.
- Get signed URLs from the asset page (**Copy transform URL**) or a Vard variant.
- Rendered on first request, then served from the bucket (`derived/`).
- Rotating `TRANSFORM_SECRET` breaks every signed URL, including locked ones.
- Video has no variants.

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

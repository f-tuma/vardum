# Runtime TLS acceptance

Production smoke calls `scripts/smoke-runtime-tls.mjs` from the image acceptance
gate after verifying the running API/worker image identity, successful one-shot
migration and application capability policies. CI and release upload the sanitized
`runtime-tls/summary.json` and `summary.txt`, including partial proof on failure.
No second application build is needed.

To replay against already verified local Linux/amd64 images:

```sh
node scripts/smoke-runtime-tls.mjs \
  "$API_IMAGE_ID" "$WORKER_IMAGE_ID" "$MIGRATE_IMAGE_ID" \
  "$POSTGRES_IMAGE_ID" "$RUSTFS_IMAGE_ID" /path/to/new/runtime-tls
```

All five inputs must be actual host `sha256:` image IDs; the three application
IDs must match. A portable server candidate caller can use this same interface
after it has verified the candidate's running host image IDs. This gate does not
load candidate archives or build images. The destination must not already exist.
Docker and host OpenSSL are required. The script owns a uniquely labelled internal
network and disposable containers, publishes no ports, and removes only resources
with its exact ownership label. It does not connect to existing database, bucket,
SMTP or QA services. Application probes and built-in Node fixture servers run in
the application image with UID 65532, no capabilities, no new privileges and
readonly fixture mounts.

The gate creates trusted, independently signed rogue, expired, and wrong-SAN
certificates. The expired leaf has a correct SAN and trusted issuer, with explicit
historical validity dates. The other negative leaves each have one invalid
property. Public fingerprints and dates survive; private keys are deleted during
bounded cleanup, including interruption and failed setup. Child operations and
cleanup have external deadlines. Evidence contains image IDs, source commit and
status, script and deployed module hashes, runtime versions (including the installed
pg-boss version and dedicated listener module hash), certificate failure categories, operation
counts, encrypted sessions, database digests and cleanup results. It does not save
raw application logs, environment, credentials, messages, private keys or URLs.

Each client starts in a fresh process and imports the image's deployed modules:
S3 put/read/bounded-read/delete against an HTTPS proxy to disposable RustFS;
`sendActionEmail` against implicit TLS and an offered SMTP STARTTLS upgrade;
the application database pool; queue startup/send/stop; the installed pg-boss
dedicated listener; the actual queue CLI through `migrateQueue`; and the full
unchanged migrator. Trusted API and worker entrypoints must become healthy, use
encrypted database and dedicated LISTEN sessions, and execute an asset-delete
job over HTTPS. Both entrypoints independently refuse each invalid PostgreSQL
certificate. PostgreSQL accepts TCP only with TLS; administrative observations
use its Unix socket. Negatives require the expected certificate code/category,
zero S3 requests/mutations, zero SMTP AUTH/envelope/DATA, and unchanged database
schema, role and sentinel digests. Timeout, authentication error or an arbitrary
nonzero exit does not pass.

SMTP STARTTLS remains opportunistic in the existing application configuration:
this gate tests validation when the server offers an upgrade, and does not claim
that an upgrade is required when absent. The matrix covers ordinary TLS validation,
not malformed-certificate exploitation, external providers or every platform.
It does not mitigate a CVE or clear the VARD55 release hold for bundled OpenSSL
3.5.8. Production base images, Compose files and application TLS policy are unchanged.

# Fictional local statement demo

This is a public portfolio sample using fictional data. It groups session records into recipient HTML previews and a JSON manifest for a fixed UTC period.

Requires Node.js 24. Run locally with a new or empty `preview` directory; `generated/` is an included, view-only example and must not be used as the output directory.

```sh
node demo.js --input fixtures.json --start 2026-08-01T00:00:00.000Z --end 2026-09-01T00:00:00.000Z --out preview
node test.js
```

Shared sessions appear once in each participant preview. Their full amount is repeated only as an informational session value; it is not apportioned and this demo creates neither invoices nor customer charges.

SQL, PostgreSQL, n8n, email delivery, network access, and production integrations are intentionally not implemented.

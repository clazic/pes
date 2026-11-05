# WEB0 spike — TypeScript core, contract checks, local platform proxies

**This is not product code.** It exists to answer the WEB0 questions in
`docs/plan/spikes/web0-plan.md`. It does not claim the `web/` module names and is
not imported by the product.

## What runs here

- `ts-core/`: one TypeScript command service (router, DTO validation, error
  envelope, canonical decimal strings, idempotency, A-round scenario).
- `ts-core/sqlite-adapter.ts`: `node:sqlite` adapter.
- `ts-core/db.ts`: `Db` interface plus the D1 adapter (same interface).
- `worker/`: Workers entry for `wrangler dev --local` (local D1 simulator).
- `test/`: 38 fixture parse/validate, seven-path normal/error/replay contract,
  decimal, router, SQLite contract, fake Go, full A-round scenario.
- `ts-core/fake-go.ts`: deterministic local Go stand-in. The documented endpoint
  is `http://127.0.0.1:<ephemeral>/inference/v1/chat/completions`; no real
  OpenCode Go call and no paid usage.

## Commands

```sh
npm ci
npm test           # node:test + node:sqlite, no network, no servers left behind
npm run typecheck  # tsc --noEmit
npm run test:d1    # local D1 contract via wrangler dev (127.0.0.1 only)
npm run measure    # 1 warmup + 3 measured + 10 consecutive per candidate;
                   # writes docs/plan/spikes/web0-measurements.csv
```

Node 26 is used locally. The test runner is `node:test` (built in, no extra
dependency). Type checking is `typescript` (`tsc --noEmit`).

### Local certificate note

In this development environment the npm registry chain ended at a cross-signed
GTS root that Node's bundled trust store did not accept, while `curl` did.
`npm ci` worked from the local npm cache; on a fresh machine, if npm reports
`UNABLE_TO_GET_ISSUER_CERT_LOCALLY`, point `NODE_EXTRA_CA_CERTS` at the
machine's trusted root bundle. This is an environment issue, not a PES
dependency or configuration change.

## Safety boundaries

- No account creation, login, card registration, payment, or deploy.
- `wrangler` runs only with `--local`; `WRANGLER_SEND_METRICS=false`.
- Servers bind `127.0.0.1` only and are stopped by the measurement runner.
- Only synthetic IDs and text. No real `~/pes-projects`, `~/.pes`, keys,
  institution material, session IDs, emails, or absolute user paths.
- The DDL and the 38 fixtures are read from `docs/plan/` without modification.

# Quick fixes and hygiene — 2026-07-26

A maintenance batch: four papercuts found by reading the code, plus the
test/CI gaps that let them go unnoticed. No new user-facing features.

## Quick fixes

### 1. Poll local service state

`useServices()` fetched once and never again, so stopping a container from
a terminal (or a crash, or an OOM kill) left the Services page claiming
`running` until a manual reload. Every other live query in the app polls.

`refetchInterval: 5000`. `refetchIntervalInBackground` stays at its default
`false`, so an unfocused tab isn't spawning `docker inspect` every five
seconds. Measured cost per poll: one `docker info` plus one `docker
inspect` per service, ~300 ms wall clock.

### 2. Pass proxy and TLS-trust vars to handlers

`BASE_ENV_KEYS` in `server/invoker.js` allowlists what crosses from the
host into a handler. It carried `PATH`, `HOME`, `TMPDIR`, `LANG`,
`JAVA_HOME` — and nothing else. On a proxied or TLS-inspecting corporate
network that means every outbound AWS SDK call fails with an opaque
timeout, with nothing in the UI pointing at the cause.

Added: `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, `NO_PROXY` (plus lowercase
variants), `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`, `SSL_CERT_DIR`,
`AWS_CA_BUNDLE`, `REQUESTS_CA_BUNDLE`, `CURL_CA_BUNDLE`.

Deliberately **not** added: `AWS_PROFILE`, `AWS_SHARED_CREDENTIALS_FILE`,
or any credential variable. Silently handing a local handler real AWS
credentials is the thing the allowlist exists to prevent. The README
already promises "nothing is inherited from your shell silently"; this
keeps that true where it matters and relaxes it only for network plumbing.

### 3. Release auto-started services on exit

Two holes, both leaving containers running with nothing left to reap them:

- **Closing the tab.** The selection lived only in the browser; the server
  kept the last selection's services up forever. Fixed with a
  `beforeunload` handler that `sendBeacon`s `{functionId: null}` to
  `/api/selection`. A normal `fetch` does not survive page teardown;
  `sendBeacon` does. Releasing the selection starts the ordinary 15 s
  grace timer, so a *reload* that comes back inside the window cancels its
  own stop — no special-casing needed.
- **Quitting the playground.** `SIGINT`/`SIGTERM` killed the process along
  with every pending grace timer. `services.stopAutoStarted()` now runs on
  the way out. It stops only what the playground auto-started; anything
  started by hand in the UI is left alone, on the same principle as the
  existing grace-timer rule.

The hook lives in `__root.tsx`, not the function page, so closing the tab
from `/services` releases the selection too.

### 4. Mask secret-looking env values

Env values rendered in plain text, so screen-sharing the playground
broadcast whatever was in the editor. `isSecretKey()` (`web/src/lib/secrets.ts`)
decides by name; matching values render as `type="password"` with a
per-row reveal toggle.

Matching splits on separators *and* camelCase humps, then looks for a
whole-token match — that is what keeps `KEYCLOAK_URL` and `TOKENIZER_PATH`
out of the net while catching `apiKey` and `AWS_SECRET_ACCESS_KEY`. A
suffix fallback catches run-together names with no separator to split on
(`PGPASSWORD`).

Reveal state rides on the row object rather than a row index, so removing
a row above a revealed one doesn't hand the reveal to a different value.
It is never persisted.

This is shoulder-surfing protection, not encryption — values are still
plain text in `functions.json`, which the README now says explicitly.

## Hygiene

- **Web tests.** `web/` had zero tests; all 140 lived on the server side,
  so a broken component shipped silently. Vitest + Testing Library +
  jsdom, 30 tests over `secrets`, `queries`, `env-editor`, `service-row`,
  `result-panel`. `web/vitest.config.ts` deliberately does not load
  `vite.config.ts`: the TanStack Start plugin does route codegen and SSR
  wiring that component tests neither need nor tolerate.
- **Root `npm test` runs both suites**, with `test:server` / `test:web`
  for running one.
- **CI** (`.github/workflows/ci.yml`): both suites, the web typecheck, and
  the web build, on push to main and on every PR.

Adding the web typecheck to CI immediately paid for itself:
`InvokeResult.phase` was typed `'init' | 'invoke'` while the server also
returns `'build'` (build command failed) and `'service'` (a required local
service isn't running). Fixed in `web/src/lib/types.ts`.

## Not done

Publishing to npm. The README still says `npx aws-playground (once
published)` and the version is still `0.1.0` — accurate, just unshipped.
Publishing needs the maintainer's npm account, so it stays their call.

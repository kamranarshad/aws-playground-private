# TanStack Start + shadcn/ui rebuild of the playground UI

Replace the vanilla-JS frontend (`public/`, vendored CodeMirror 5) and the
Express server with a TanStack Start app using shadcn/ui components,
adding a Postman-style split-pane layout, persistent invoke history, and
a command palette.

Decisions made during brainstorming:

- Framework: **TanStack Start** (v1.168+, TypeScript), owning the whole
  server — Express is removed.
- Editor: **CodeMirror 6** via `@uiw/react-codemirror` (JSON mode),
  replacing the vendored CodeMirror 5.
- Scope: UX rethink with **split-pane request/response**, **persistent
  invoke history**, and **command palette + shortcuts**. Request tabs,
  streaming logs, and multi-invoke are explicitly out of scope.

## 1. Architecture

- New Start app in `web/` (TypeScript, own private `package.json`).
  Built with `vite build` → `web/.output/`; production server entry is
  `web/.output/server/index.mjs`, which respects `PORT` and `HOST`.
- The API endpoints become Start server routes. They import the existing
  plain-JS modules (`server/store.js`, `server/detect.js`,
  `server/invoker.js`) unchanged.
- Route logic (validation, status codes, in-flight guard) moves from
  Express into a framework-agnostic `server/api.js`: one plain function
  per endpoint returning `{ status, body }`. Start server routes are
  thin adapters (parse request → call handler → JSON response).
  `server/index.js` (Express) and the `express` dependency are deleted,
  along with `public/`.
- `bin/cli.js` spawns `node web/.output/server/index.mjs` with
  `HOST=127.0.0.1` (preserving loopback-only binding), `PORT` (default
  4590, `--port` flag), and `AWS_PLAYGROUND_DATA_DIR` passed through,
  waits for the port to accept connections, then opens the browser
  (`--no-open` supported). If `web/.output` is missing it exits with a
  "run `npm run build` first" message.

## 2. Persistent invoke history

- New `server/history.js`, same style as `store.js`:
  - `append(functionId, entry)` — writes one JSON line to
    `<dataDir>/history/<functionId>.jsonl`; trims the file to the newest
    50 entries; truncates `logs`, `report`, and stringified
    `event`/`response` fields at 64 KB each, setting `truncated: true`.
  - `list(functionId)` — newest first.
  - `clear(functionId)` — removes the file (also called when a function
    is deleted).
- Entry shape: `{ id, ts, handler, event, response, error, logs,
  report, durationMs, ok }`.
- The invoke handler in `api.js` records every completed invoke
  (success or handler error; not transport-level 4xx like unknown
  function).
- New endpoints: `GET /api/functions/:id/history`,
  `DELETE /api/functions/:id/history`.

## 3. UI

shadcn/ui components throughout; dark/light theme toggle (persisted in
localStorage); Sonner toasts for API errors; TanStack Query for all data
fetching.

```
+--------------------------------------------------------------+
| Lambda Playground     [py ok][node ok][java --]   Cmd-K  theme|
+-----------+--------------------------------------------------+
| Functions | my-fn [node]  handler - 3000ms - 128MB  gear  del |
|  - my-fn  +---------------------------+----------------------+
|  - apigw  | EVENT (CodeMirror 6 JSON) | Response|Logs|Report| |
|  + Add    | [template v][saved v][save]  History             |
|           |                           |  ok 200 - 12ms - 2m  |
|           |      [Invoke Cmd-Enter]   |  err   -  8ms - 5m   |
|           +------- resizable ---------+----------------------+
+-----------+--------------------------------------------------+
```

- **Sidebar** (shadcn Sidebar): function list with runtime Badges;
  health chips for python/node/java in the header (from `/api/health`).
  "Add function" opens a Dialog: path input first; on blur/typing it
  calls `/api/detect` and auto-fills name, runtime, and handler
  suggestions.
- **Function header**: name + runtime badge; handler, timeout, memory,
  and jar path (java only) edited in a Settings sheet; Delete with a
  confirm dialog. Env vars in a Collapsible key/value table (add,
  edit, remove rows; saved via PATCH).
- **Split-pane** (Resizable, horizontal): left is the CM6 JSON event
  editor with event-template picker, saved-events picker, and save
  button; right is Tabs: Response / Logs / Report / History.
- **History tab**: persisted runs listed with ok/error badge, duration,
  relative age. Selecting a run shows its response/logs/report and a
  "Load event" button that copies the run's event into the editor.
  A clear-history action calls the DELETE endpoint.
- **Command palette** (shadcn Command, Cmd-K): switch function, invoke,
  add function, toggle theme. Cmd-Enter invokes. Invalid JSON in the
  editor disables Invoke and shows an inline marker.
- Invoke button shows an in-flight spinner; a 409 (already in flight)
  surfaces as a toast.

## 4. Testing

- `tests/api.test.js` rewritten against the `server/api.js` handler
  functions directly — no HTTP server needed. Same cases as today plus
  history endpoints.
- New `tests/history.test.js`: append/list/clear, 50-entry cap, 64 KB
  truncation, deletion on function removal.
- New `tests/web.test.js` E2E smoke: if `web/.output` exists, spawn the
  built server on a random free port with a temp data dir, assert `/`
  returns the app shell (200, html) and `/api/health` returns runtime
  JSON; skip (like the Java tests) when the build output is absent.
- `tests/frontend.test.js` is deleted (superseded by `web.test.js`).
  Store/detect/invoker/harness tests are untouched.

## 5. Packaging & workflow

- Root `engines.node` → `>=22.12.0` (TanStack Start's requirement).
  This is the requirement to *run the playground*; the node runtime row
  in the README (user Lambda projects need node >= 18) is unchanged.
- Root `files` gains `web/.output` and drops `public`. `express` is
  removed from dependencies. `prepublishOnly` runs the web build so the
  published package (and `npm install -g .` from a built checkout)
  always ships a fresh build.
- Scripts: root `npm run build` → `npm --prefix web run build`;
  `npm run dev` → Start's Vite dev server in `web/` (server routes work
  in dev, no proxy); root `npm start` unchanged (CLI, `--no-open`).
- README updated: install/run unchanged for users, development section
  gains the build step, screenshots/description of the new UI.

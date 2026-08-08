# Settings dialog with editable name

**Date:** 2026-08-09
**Status:** Approved (design conversation), pending spec review

## Goal

Two changes to the function settings UI: the function name becomes editable,
and the settings surface changes from a slide-in sheet to a centered modal
dialog (which also picks up the ember dialog treatment — square corners,
corner brackets).

## Scope

Frontend only. The server's PATCH endpoint already accepts `name`
(`server/store.js` `ALLOWED_KEYS`); no API, store, or type changes.

## Design

- `web/src/components/settings-sheet.tsx` is renamed to
  `web/src/components/settings-dialog.tsx`; `SettingsSheet` becomes
  `SettingsDialog`. The `Sheet*` primitives are replaced by the matching
  `Dialog*` primitives (`Dialog`, `DialogTrigger`, `DialogContent`,
  `DialogHeader`, `DialogTitle`, `DialogFooter`). Form body and footer are
  otherwise unchanged. `web/src/components/function-header.tsx` — the only
  call site — updates its import and usage.
- A "Name" field is added at the top of the form: state seeded from
  `fn.name`, re-seeded on `fn` change like the other fields, saved through
  the same `useUpdateFunction` patch. Forgiving-input rule, matching the
  form's existing style: the trimmed value is sent, and a blank name keeps
  the current one (`name: name.trim() || fn.name`).
- The dialog title stays `Settings — {fn.name}` and reflects the saved name
  (it reads the query-cache value, not the draft). Sidebar and header update
  automatically for the same reason.

## Non-goals

- No click-to-edit on the header title; the name edits only in settings.
- No uniqueness validation — the server has none, and function identity is
  `id`, not name.
- No other settings-form changes.

## Testing

New `web/src/components/settings-dialog.test.tsx` (testing-library, existing
patterns): renaming saves the trimmed name through the PATCH call; a blank
name falls back to the current name; the dialog opens from the settings
trigger. Existing suites must stay green (`npm run test:web`,
`npm --prefix web run typecheck`).

## Verification

Both-theme dev-server check that the modal renders with the ember dialog
treatment and the rename propagates to sidebar/header, then rebuild
`web/dist`.

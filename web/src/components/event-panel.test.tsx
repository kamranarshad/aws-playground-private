import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

vi.mock('@/lib/api', () => ({
  api: { detect: vi.fn(), updateFunction: vi.fn(), health: vi.fn() },
}))

import { EventPanel } from '@/components/event-panel'
import { api } from '@/lib/api'
import type { FunctionDef, SavedEvent } from '@/lib/types'

function stubClipboard(writeText: () => Promise<void> = async () => {}) {
  Object.defineProperty(window.navigator, 'clipboard', {
    value: { writeText: vi.fn(writeText) }, configurable: true,
  })
  return window.navigator.clipboard.writeText as ReturnType<typeof vi.fn>
}

beforeEach(() => {
  vi.mocked(api.detect).mockResolvedValue({ runtime: 'node', handlerCandidates: [], projectTrigger: null })
})

afterEach(() => vi.clearAllMocks())

function makeFn(overrides: Partial<FunctionDef> = {}): FunctionDef {
  return {
    id: 'fn-1', name: 'fn', path: '/tmp/fn', runtime: 'node', handler: 'index.handler',
    timeoutMs: 3000, memoryMb: 128, jarPath: null, env: {}, envFile: '', buildCommand: '',
    localServices: [], trigger: null, savedEvents: [], autoTrace: false, ...overrides,
  }
}

const TEST_PORTS = {
  httpTrigger: 9500, s3Webhook: 9501, minio: 9400, minioConsole: 9401,
  dynamodb: 9402, redis: 9403, postgres: 9404,
}

function Wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  // The curl button reads the HTTP trigger port from the health query rather
  // than a constant, so it has to be cached before the first render.
  qc.setQueryData(['health'], { runtimes: {}, ports: TEST_PORTS })
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>
}

// The main JSON editor is always the first CodeMirror instance in the tree;
// the inline assertion-script editor is the second. Both are always mounted
// (the script editor no longer lives inside the Save dialog), so tests target
// them by position rather than needing the dialog open.
function scriptEditor() {
  const editor = document.querySelectorAll('.cm-content')[1]
  if (!editor) throw new Error('script CodeMirror did not mount')
  return editor
}

function jsonEditor() {
  const editor = document.querySelectorAll('.cm-content')[0]
  if (!editor) throw new Error('JSON CodeMirror did not mount')
  return editor
}

// CodeMirror's own default keymap binds Mod-Enter to insertBlankLine (its
// documented "Ctrl-Enter / Cmd-Enter" behavior), which runs inside the
// editor before the app's window-level Cmd+Enter listener ever sees the
// event — so that listener's preventDefault is too late to stop a newline
// CodeMirror already inserted through its own transaction system.
it('invokes on Cmd+Enter from inside the JSON editor, instead of inserting a blank line', () => {
  const onInvoke = vi.fn()
  const onEventTextChange = vi.fn()
  render(
    <EventPanel
      fn={makeFn()} eventText={'{}'} onEventTextChange={onEventTextChange}
      onInvoke={onInvoke} invoking={false} onScriptChange={vi.fn()}
      hasResult={false} onRunChecks={vi.fn()}
    />,
    { wrapper: Wrapper },
  )

  // CodeMirror's "Mod-Enter" binding normalizes to the platform's own
  // modifier — Meta (Cmd) on a real Mac, which is what a user pressing
  // Cmd+Enter sends, but Ctrl under jsdom's non-Mac platform detection.
  // Firing whichever one jsdom will actually match exercises the same
  // precedence fix regardless of which one a real browser resolves to.
  fireEvent.keyDown(jsonEditor(), { key: 'Enter', ctrlKey: true })

  expect(onInvoke).toHaveBeenCalledTimes(1)
  expect(onEventTextChange).not.toHaveBeenCalled()
})

// index.tsx's own window-level Cmd+Enter shortcut (for when focus is
// anywhere else in the app) sits above the editor in the same bubble chain.
// Handling the key inside CodeMirror without stopping propagation would let
// that outer listener fire too — two invokes for one keypress, which is
// exactly what trips the server's "an invoke is already in flight" guard.
it('does not also trigger a window-level Cmd+Enter listener above it', () => {
  const onInvoke = vi.fn()
  const windowHandler = vi.fn()
  window.addEventListener('keydown', windowHandler)
  try {
    render(
      <EventPanel
        fn={makeFn()} eventText={'{}'} onEventTextChange={vi.fn()}
        onInvoke={onInvoke} invoking={false} onScriptChange={vi.fn()}
        hasResult={false} onRunChecks={vi.fn()}
      />,
      { wrapper: Wrapper },
    )

    fireEvent.keyDown(jsonEditor(), { key: 'Enter', ctrlKey: true })

    expect(onInvoke).toHaveBeenCalledTimes(1)
    expect(windowHandler).not.toHaveBeenCalled()
  } finally {
    window.removeEventListener('keydown', windowHandler)
  }
})

it('hides "Copy as curl" when the function has no HTTP trigger', () => {
  render(
    <EventPanel
      fn={makeFn()} eventText={'{}'} onEventTextChange={vi.fn()}
      onInvoke={vi.fn()} invoking={false} onScriptChange={vi.fn()}
      hasResult={false} onRunChecks={vi.fn()}
    />,
    { wrapper: Wrapper },
  )
  expect(screen.queryByRole('button', { name: /copy as curl/i })).not.toBeInTheDocument()
})

it('hides "Copy as curl" when the function\'s HTTP trigger is configured but disabled', () => {
  const fn = makeFn({ trigger: { type: 'http', enabled: false } })
  render(
    <EventPanel
      fn={fn} eventText={'{}'} onEventTextChange={vi.fn()}
      onInvoke={vi.fn()} invoking={false} onScriptChange={vi.fn()}
      hasResult={false} onRunChecks={vi.fn()}
    />,
    { wrapper: Wrapper },
  )
  expect(screen.queryByRole('button', { name: /copy as curl/i })).not.toBeInTheDocument()
})

it('copies a curl command built from the current event when the HTTP trigger is enabled', async () => {
  const writeText = stubClipboard()
  const fn = makeFn({ name: 'myfn', trigger: { type: 'http', enabled: true } })
  const event = { rawPath: '/hello', requestContext: { http: { method: 'GET' } } }
  render(
    <EventPanel
      fn={fn} eventText={JSON.stringify(event)} onEventTextChange={vi.fn()}
      onInvoke={vi.fn()} invoking={false} onScriptChange={vi.fn()}
      hasResult={false} onRunChecks={vi.fn()}
    />,
    { wrapper: Wrapper },
  )

  await userEvent.click(screen.getByRole('button', { name: /copy as curl/i }))

  expect(writeText).toHaveBeenCalledWith("curl -X GET 'http://localhost:9500/myfn/hello'")
})

it('shows "Copy as curl" for a playground.json-declared HTTP trigger', async () => {
  vi.mocked(api.detect).mockResolvedValue({
    runtime: 'node', handlerCandidates: [], projectTrigger: { type: 'http', enabled: true },
  })
  render(
    <EventPanel
      fn={makeFn()} eventText={'{}'} onEventTextChange={vi.fn()}
      onInvoke={vi.fn()} invoking={false} onScriptChange={vi.fn()}
      hasResult={false} onRunChecks={vi.fn()}
    />,
    { wrapper: Wrapper },
  )
  expect(await screen.findByRole('button', { name: /copy as curl/i })).toBeInTheDocument()
})

it('saves whatever is currently in the inline script editor alongside a named event', async () => {
  vi.mocked(api.updateFunction).mockResolvedValue(makeFn())
  const user = userEvent.setup()
  render(
    <EventPanel
      fn={makeFn()} eventText={'{"a":1}'} onEventTextChange={vi.fn()}
      onInvoke={vi.fn()} invoking={false} onScriptChange={vi.fn()}
      hasResult={false} onRunChecks={vi.fn()}
    />,
    { wrapper: Wrapper },
  )

  await user.click(scriptEditor())
  await user.keyboard('expect(response.statusCode).toBe(200)')
  await user.click(screen.getByRole('button', { name: /save/i }))
  await user.type(screen.getByPlaceholderText('Event name'), 'foo')
  await user.click(screen.getByRole('button', { name: 'Save' }))

  expect(api.updateFunction).toHaveBeenCalledWith('fn-1', {
    savedEvents: [{
      name: 'foo', event: { a: 1 }, assertionScript: 'expect(response.statusCode).toBe(200)',
    }],
  })
})

it('omits assertionScript when the inline script editor is left blank', async () => {
  vi.mocked(api.updateFunction).mockResolvedValue(makeFn())
  const user = userEvent.setup()
  render(
    <EventPanel
      fn={makeFn()} eventText={'{"a":1}'} onEventTextChange={vi.fn()}
      onInvoke={vi.fn()} invoking={false} onScriptChange={vi.fn()}
      hasResult={false} onRunChecks={vi.fn()}
    />,
    { wrapper: Wrapper },
  )

  await user.click(screen.getByRole('button', { name: /save/i }))
  await user.type(screen.getByPlaceholderText('Event name'), 'foo')
  await user.click(screen.getByRole('button', { name: 'Save' }))

  expect(api.updateFunction).toHaveBeenCalledWith('fn-1', {
    savedEvents: [{ name: 'foo', event: { a: 1 } }],
  })
})

it('seeds the inline script editor when a saved event is loaded from the dropdown', async () => {
  const saved: SavedEvent = {
    name: 'foo', event: { a: 1 }, assertionScript: 'expect(response.statusCode).toBe(200)',
  }
  const onEventTextChange = vi.fn()
  const onScriptChange = vi.fn()
  const user = userEvent.setup()
  render(
    <EventPanel
      fn={makeFn({ savedEvents: [saved] })} eventText={'{}'} onEventTextChange={onEventTextChange}
      onInvoke={vi.fn()} invoking={false} onScriptChange={onScriptChange}
      hasResult={false} onRunChecks={vi.fn()}
    />,
    { wrapper: Wrapper },
  )

  await user.click(screen.getAllByRole('combobox')[1])
  await user.click(screen.getByRole('option', { name: 'foo' }))

  expect(onEventTextChange).toHaveBeenCalledWith(JSON.stringify({ a: 1 }, null, 2))
  expect(scriptEditor()).toHaveTextContent('expect(response.statusCode).toBe(200)')
  expect(onScriptChange).toHaveBeenCalled()
})

it('clears the inline script editor when a template is loaded instead', async () => {
  const saved: SavedEvent = {
    name: 'foo', event: { a: 1 }, assertionScript: 'expect(response.statusCode).toBe(200)',
  }
  const onScriptChange = vi.fn()
  const user = userEvent.setup()
  render(
    <EventPanel
      fn={makeFn({ savedEvents: [saved] })} eventText={'{}'} onEventTextChange={vi.fn()}
      onInvoke={vi.fn()} invoking={false} onScriptChange={onScriptChange}
      hasResult={false} onRunChecks={vi.fn()}
    />,
    { wrapper: Wrapper },
  )

  await user.click(screen.getAllByRole('combobox')[1])
  await user.click(screen.getByRole('option', { name: 'foo' }))
  expect(scriptEditor()).toHaveTextContent('expect(response.statusCode).toBe(200)')

  await user.click(screen.getAllByRole('combobox')[0])
  await user.click(screen.getAllByRole('option')[0])

  // The editor shows its placeholder, which is only rendered for an empty doc.
  expect(scriptEditor().querySelector('.cm-placeholder')).toBeInTheDocument()
  expect(onScriptChange).toHaveBeenCalledTimes(2)
})

// The old behavior cleared the script on any hand-edit. That fought the
// point of an inline editor you're meant to iterate in alongside the event
// body — you're usually tweaking both together, not starting over.
it('keeps the inline script when the JSON body is hand-edited', async () => {
  const saved: SavedEvent = {
    name: 'foo', event: { a: 1 }, assertionScript: 'expect(response.statusCode).toBe(200)',
  }
  const onScriptChange = vi.fn()
  const user = userEvent.setup()
  render(
    <EventPanel
      fn={makeFn({ savedEvents: [saved] })} eventText={'{}'} onEventTextChange={vi.fn()}
      onInvoke={vi.fn()} invoking={false} onScriptChange={onScriptChange}
      hasResult={false} onRunChecks={vi.fn()}
    />,
    { wrapper: Wrapper },
  )

  await user.click(screen.getAllByRole('combobox')[1])
  await user.click(screen.getByRole('option', { name: 'foo' }))
  onScriptChange.mockClear()

  await user.click(jsonEditor())
  await user.keyboard('x')

  expect(scriptEditor()).toHaveTextContent('expect(response.statusCode).toBe(200)')
  expect(onScriptChange).not.toHaveBeenCalled()
})

it('labels the inline script editor for assistive tech', () => {
  render(
    <EventPanel
      fn={makeFn()} eventText={'{}'} onEventTextChange={vi.fn()}
      onInvoke={vi.fn()} invoking={false} onScriptChange={vi.fn()}
      hasResult={false} onRunChecks={vi.fn()}
    />,
    { wrapper: Wrapper },
  )

  expect(screen.getByRole('textbox', { name: 'Assertion script' })).toBeInTheDocument()
})

it('disables Run checks until there is a script and a result', () => {
  render(
    <EventPanel
      fn={makeFn()} eventText={'{}'} onEventTextChange={vi.fn()}
      onInvoke={vi.fn()} invoking={false} onScriptChange={vi.fn()}
      hasResult={false} onRunChecks={vi.fn()}
    />,
    { wrapper: Wrapper },
  )

  expect(screen.getByRole('button', { name: /run checks/i })).toBeDisabled()
})

it('enables Run checks once a script is typed and a result exists, and passes the script through', async () => {
  const onRunChecks = vi.fn()
  const user = userEvent.setup()
  render(
    <EventPanel
      fn={makeFn()} eventText={'{}'} onEventTextChange={vi.fn()}
      onInvoke={vi.fn()} invoking={false} onScriptChange={vi.fn()}
      hasResult={true} onRunChecks={onRunChecks}
    />,
    { wrapper: Wrapper },
  )

  expect(screen.getByRole('button', { name: /run checks/i })).toBeDisabled()

  await user.click(scriptEditor())
  await user.keyboard('expect(1).toBe(1)')
  await user.click(screen.getByRole('button', { name: /run checks/i }))

  expect(onRunChecks).toHaveBeenCalledWith('expect(1).toBe(1)')
})

it('stays disabled with a non-blank script if there is no result yet', async () => {
  const user = userEvent.setup()
  render(
    <EventPanel
      fn={makeFn()} eventText={'{}'} onEventTextChange={vi.fn()}
      onInvoke={vi.fn()} invoking={false} onScriptChange={vi.fn()}
      hasResult={false} onRunChecks={vi.fn()}
    />,
    { wrapper: Wrapper },
  )

  await user.click(scriptEditor())
  await user.keyboard('expect(1).toBe(1)')

  expect(screen.getByRole('button', { name: /run checks/i })).toBeDisabled()
})

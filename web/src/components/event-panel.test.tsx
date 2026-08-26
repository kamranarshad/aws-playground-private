import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

vi.mock('@/lib/api', () => ({
  api: { detect: vi.fn(), updateFunction: vi.fn() },
}))

import { EventPanel } from '@/components/event-panel'
import { api } from '@/lib/api'
import type { FunctionDef } from '@/lib/types'

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
    localServices: [], trigger: null, savedEvents: [], ...overrides,
  }
}

function Wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>
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
      onInvoke={onInvoke} invoking={false}
    />,
    { wrapper: Wrapper },
  )
  const editor = document.querySelector('.cm-content')
  if (!editor) throw new Error('CodeMirror content element did not mount')

  // CodeMirror's "Mod-Enter" binding normalizes to the platform's own
  // modifier — Meta (Cmd) on a real Mac, which is what a user pressing
  // Cmd+Enter sends, but Ctrl under jsdom's non-Mac platform detection.
  // Firing whichever one jsdom will actually match exercises the same
  // precedence fix regardless of which one a real browser resolves to.
  fireEvent.keyDown(editor, { key: 'Enter', ctrlKey: true })

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
        onInvoke={onInvoke} invoking={false}
      />,
      { wrapper: Wrapper },
    )
    const editor = document.querySelector('.cm-content')
    if (!editor) throw new Error('CodeMirror content element did not mount')

    fireEvent.keyDown(editor, { key: 'Enter', ctrlKey: true })

    expect(onInvoke).toHaveBeenCalledTimes(1)
    expect(windowHandler).not.toHaveBeenCalled()
  } finally {
    window.removeEventListener('keydown', windowHandler)
  }
})

it('hides "Copy as curl" when the function has no HTTP trigger', () => {
  render(
    <EventPanel fn={makeFn()} eventText={'{}'} onEventTextChange={vi.fn()} onInvoke={vi.fn()} invoking={false} />,
    { wrapper: Wrapper },
  )
  expect(screen.queryByRole('button', { name: /copy as curl/i })).not.toBeInTheDocument()
})

it('hides "Copy as curl" when the function\'s HTTP trigger is configured but disabled', () => {
  const fn = makeFn({ trigger: { type: 'http', enabled: false } })
  render(
    <EventPanel fn={fn} eventText={'{}'} onEventTextChange={vi.fn()} onInvoke={vi.fn()} invoking={false} />,
    { wrapper: Wrapper },
  )
  expect(screen.queryByRole('button', { name: /copy as curl/i })).not.toBeInTheDocument()
})

it('copies a curl command built from the current event when the HTTP trigger is enabled', async () => {
  const writeText = stubClipboard()
  const fn = makeFn({ name: 'myfn', trigger: { type: 'http', enabled: true } })
  const event = { rawPath: '/hello', requestContext: { http: { method: 'GET' } } }
  render(
    <EventPanel fn={fn} eventText={JSON.stringify(event)} onEventTextChange={vi.fn()}
      onInvoke={vi.fn()} invoking={false} />,
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
    <EventPanel fn={makeFn()} eventText={'{}'} onEventTextChange={vi.fn()} onInvoke={vi.fn()} invoking={false} />,
    { wrapper: Wrapper },
  )
  expect(await screen.findByRole('button', { name: /copy as curl/i })).toBeInTheDocument()
})

import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'

vi.mock('@/lib/api', () => ({
  api: { updateFunction: vi.fn() },
}))

import { EventPanel } from '@/components/event-panel'
import { api } from '@/lib/api'
import type { FunctionDef, SavedEvent } from '@/lib/types'

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
      onInvoke={onInvoke} invoking={false} onLoadSavedEvent={vi.fn()}
      canRunChecks={false} onRunChecks={vi.fn()}
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
        onInvoke={onInvoke} invoking={false} onLoadSavedEvent={vi.fn()}
        canRunChecks={false} onRunChecks={vi.fn()}
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

it('saves an assertion script alongside a named event', async () => {
  vi.mocked(api.updateFunction).mockResolvedValue(makeFn())
  const user = userEvent.setup()
  render(
    <EventPanel
      fn={makeFn()} eventText={'{"a":1}'} onEventTextChange={vi.fn()}
      onInvoke={vi.fn()} invoking={false} onLoadSavedEvent={vi.fn()}
      canRunChecks={false} onRunChecks={vi.fn()}
    />,
    { wrapper: Wrapper },
  )

  await user.click(screen.getByRole('button', { name: /save/i }))
  await user.type(screen.getByPlaceholderText('Event name'), 'foo')
  const dialog = screen.getByRole('dialog')
  const scriptEditor = dialog.querySelector('.cm-content')
  if (!scriptEditor) throw new Error('script CodeMirror did not mount')
  await user.click(scriptEditor)
  await user.keyboard('expect(response.statusCode).toBe(200)')
  await user.click(screen.getByRole('button', { name: 'Save' }))

  expect(api.updateFunction).toHaveBeenCalledWith('fn-1', {
    savedEvents: [{
      name: 'foo', event: { a: 1 }, assertionScript: 'expect(response.statusCode).toBe(200)',
    }],
  })
})

it('omits assertionScript when the field is left blank', async () => {
  vi.mocked(api.updateFunction).mockResolvedValue(makeFn())
  const user = userEvent.setup()
  render(
    <EventPanel
      fn={makeFn()} eventText={'{"a":1}'} onEventTextChange={vi.fn()}
      onInvoke={vi.fn()} invoking={false} onLoadSavedEvent={vi.fn()}
      canRunChecks={false} onRunChecks={vi.fn()}
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

it('surfaces a saved event\'s assertion when it is loaded from the dropdown', async () => {
  const saved: SavedEvent = {
    name: 'foo', event: { a: 1 }, assertionScript: 'expect(response.statusCode).toBe(200)',
  }
  const onEventTextChange = vi.fn()
  const onLoadSavedEvent = vi.fn()
  const user = userEvent.setup()
  render(
    <EventPanel
      fn={makeFn({ savedEvents: [saved] })} eventText={'{}'} onEventTextChange={onEventTextChange}
      onInvoke={vi.fn()} invoking={false} onLoadSavedEvent={onLoadSavedEvent}
      canRunChecks={false} onRunChecks={vi.fn()}
    />,
    { wrapper: Wrapper },
  )

  await user.click(screen.getAllByRole('combobox')[1])
  await user.click(screen.getByRole('option', { name: 'foo' }))

  expect(onEventTextChange).toHaveBeenCalledWith(JSON.stringify({ a: 1 }, null, 2))
  expect(onLoadSavedEvent).toHaveBeenCalledWith(saved)
})

it('clears the active assertion when a template is loaded instead', async () => {
  const saved: SavedEvent = {
    name: 'foo', event: { a: 1 }, assertionScript: 'expect(response.statusCode).toBe(200)',
  }
  const onLoadSavedEvent = vi.fn()
  const user = userEvent.setup()
  render(
    <EventPanel
      fn={makeFn({ savedEvents: [saved] })} eventText={'{}'} onEventTextChange={vi.fn()}
      onInvoke={vi.fn()} invoking={false} onLoadSavedEvent={onLoadSavedEvent}
      canRunChecks={false} onRunChecks={vi.fn()}
    />,
    { wrapper: Wrapper },
  )

  await user.click(screen.getAllByRole('combobox')[0])
  await user.click(screen.getAllByRole('option')[0])

  expect(onLoadSavedEvent).toHaveBeenCalledWith(null)
})

it('clears the active assertion when the event is hand-edited', async () => {
  const saved: SavedEvent = {
    name: 'foo', event: { a: 1 }, assertionScript: 'expect(response.statusCode).toBe(200)',
  }
  const onLoadSavedEvent = vi.fn()
  const user = userEvent.setup()
  render(
    <EventPanel
      fn={makeFn({ savedEvents: [saved] })} eventText={'{}'} onEventTextChange={vi.fn()}
      onInvoke={vi.fn()} invoking={false} onLoadSavedEvent={onLoadSavedEvent}
      canRunChecks={false} onRunChecks={vi.fn()}
    />,
    { wrapper: Wrapper },
  )
  const editor = document.querySelector('.cm-content')
  if (!editor) throw new Error('CodeMirror content element did not mount')

  await user.click(editor)
  await user.keyboard('x')

  expect(onLoadSavedEvent).toHaveBeenCalledWith(null)
})

it('disables the Run checks button until there is an active assertion and a result', () => {
  render(
    <EventPanel
      fn={makeFn()} eventText={'{}'} onEventTextChange={vi.fn()}
      onInvoke={vi.fn()} invoking={false} onLoadSavedEvent={vi.fn()}
      canRunChecks={false} onRunChecks={vi.fn()}
    />,
    { wrapper: Wrapper },
  )

  expect(screen.getByRole('button', { name: /run checks/i })).toBeDisabled()
})

it('runs checks when the button is pressed', async () => {
  const onRunChecks = vi.fn()
  const user = userEvent.setup()
  render(
    <EventPanel
      fn={makeFn()} eventText={'{}'} onEventTextChange={vi.fn()}
      onInvoke={vi.fn()} invoking={false} onLoadSavedEvent={vi.fn()}
      canRunChecks={true} onRunChecks={onRunChecks}
    />,
    { wrapper: Wrapper },
  )

  await user.click(screen.getByRole('button', { name: /run checks/i }))

  expect(onRunChecks).toHaveBeenCalledTimes(1)
})

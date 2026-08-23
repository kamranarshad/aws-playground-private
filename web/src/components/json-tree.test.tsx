import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))

import { JsonTree } from '@/components/json-tree'

function stubClipboard() {
  const writeText = vi.fn(async () => {})
  Object.defineProperty(window.navigator, 'clipboard', {
    value: { writeText }, configurable: true,
  })
  return writeText
}

afterEach(() => vi.clearAllMocks())

it('renders each key with its value', () => {
  render(<JsonTree value={{ statusCode: 200, ok: true, note: 'hi', extra: null }} />)

  expect(screen.getByText('statusCode')).toBeInTheDocument()
  expect(screen.getByText('200')).toBeInTheDocument()
  expect(screen.getByText('true')).toBeInTheDocument()
  expect(screen.getByText('"hi"')).toBeInTheDocument()
  expect(screen.getByText('null')).toBeInTheDocument()
})

it('collapses a nested object, hiding its children', async () => {
  // Two keys at the root so its own count can't be confused with headers'.
  render(<JsonTree value={{ statusCode: 200, headers: { 'content-type': 'application/json' } }} />)
  expect(screen.getByText('content-type')).toBeInTheDocument()

  await userEvent.click(screen.getByLabelText('Collapse headers'))

  expect(screen.queryByText('content-type')).not.toBeInTheDocument()
  expect(screen.getByText('1 key')).toBeInTheDocument()
})

// Deep responses would otherwise dump hundreds of rows on arrival.
it('auto-expands the root plus two levels, no further', () => {
  render(<JsonTree value={{ a: { b: { c: { deep: 1 } } } }} />)

  expect(screen.getByText('b')).toBeInTheDocument()
  expect(screen.queryByText('deep')).not.toBeInTheDocument()
  expect(screen.getByLabelText('Expand c')).toBeInTheDocument()
})

it('numbers array entries and counts them when collapsed', async () => {
  render(<JsonTree value={{ items: ['a', 'b'] }} />)
  expect(screen.getByText('0')).toBeInTheDocument()

  await userEvent.click(screen.getByLabelText('Collapse items'))

  expect(screen.getByText(/2 items/)).toBeInTheDocument()
})

// API Gateway proxy responses carry their payload as a JSON *string* in `body`,
// which is the single least readable thing a flat dump produces.
it('expands a JSON string into a nested tree', () => {
  render(<JsonTree value={{ body: '{"userId":7}' }} />)

  expect(screen.getByText('userId')).toBeInTheDocument()
  expect(screen.getByText('7')).toBeInTheDocument()
})

it('shows the raw text when a JSON string is collapsed', async () => {
  render(<JsonTree value={{ body: '{"userId":7}' }} />)

  await userEvent.click(screen.getByLabelText('Collapse body'))

  expect(screen.queryByText('userId')).not.toBeInTheDocument()
  expect(screen.getByText('"{\\"userId\\":7}"')).toBeInTheDocument()
})

it('leaves a string that only looks like JSON alone', () => {
  render(<JsonTree value={{ body: '{not json' }} />)

  expect(screen.getByText('"{not json"')).toBeInTheDocument()
  expect(screen.queryByLabelText(/Expand|Collapse.*body/)).not.toBeInTheDocument()
})

it('renders a bare primitive response', () => {
  render(<JsonTree value="done" />)

  expect(screen.getByText('"done"')).toBeInTheDocument()
})

it('renders empty containers inline', () => {
  render(<JsonTree value={{ headers: {}, items: [] }} />)

  expect(screen.getByText('0 keys')).toBeInTheDocument()
  expect(screen.getByText('0 items')).toBeInTheDocument()
  expect(screen.queryByLabelText(/Expand|Collapse.*headers/)).not.toBeInTheDocument()
})

// Indentation and the guide rails carry the nesting, so the braces and the
// closing-bracket rows they need are just noise.
it('renders no JSON punctuation', () => {
  const { container } = render(<JsonTree value={{ headers: { a: 'b' }, items: [1] }} />)

  expect(container.textContent).not.toMatch(/[{}[\]]/)
})

it('counts the root itself, so the whole response can collapse', async () => {
  render(<JsonTree value={{ a: 1, b: 2 }} />)
  expect(screen.getByText('2 keys')).toBeInTheDocument()

  await userEvent.click(screen.getByLabelText('Collapse root'))

  expect(screen.queryByText('a')).not.toBeInTheDocument()
  expect(screen.getByText('2 keys')).toBeInTheDocument()
})

// Quotes must still not break a value out of its row, and out of its own
// quoting — but a real newline (a logged Error.stack, most often) has to stay
// a line break, not JSON.stringify's escaped "\n", or a stack trace prints
// as one unreadable line.
it('escapes a quote in a single-line string the way JSON does', () => {
  render(<JsonTree value={{ msg: 'say "hi"' }} />)

  expect(screen.getByText('"say \\"hi\\""')).toBeInTheDocument()
})

it('keeps a real line break in a multi-line string instead of escaping it', () => {
  const { container } = render(<JsonTree value={{ msg: 'say "hi"\nbye' }} />)

  // Quotes stay escaped so the value still reads as a JSON string; the
  // newline between them is an actual line break, not printed text.
  expect(container.textContent).toContain('"say \\"hi\\"\nbye"')
  expect(container.querySelector('.whitespace-pre-wrap')).not.toBeNull()
})

// The motivating case: a logged Error.stack riding along as a JSON
// attribute (see fixtures/typescript/winston-datadog) must stay legible once
// the row is expanded, frames on their own lines rather than run together.
it('formats a stack trace on real line breaks when its row is expanded', () => {
  const stack =
    "RangeError: no order matching 'A-1001' in the local store\n"
    + '    at readFromStore (/app/dist/index.js:10806:9)\n'
    + '    at lookupOrder (/app/dist/index.js:10809:10)'
  const { container } = render(<JsonTree value={{ error: { kind: 'RangeError', stack } }} />)

  expect(container.textContent).toContain(
    "\"RangeError: no order matching 'A-1001' in the local store\n"
    + '    at readFromStore (/app/dist/index.js:10806:9)\n'
    + '    at lookupOrder (/app/dist/index.js:10809:10)"',
  )
})

it('copies a leaf value as its own JSON, not the whole response', async () => {
  const writeText = stubClipboard()
  render(<JsonTree value={{ statusCode: 200, body: 'hi' }} />)

  await userEvent.click(screen.getByLabelText('Copy statusCode'))

  expect(writeText).toHaveBeenCalledWith('200')
})

it('copies a subtree independent of its expand state', async () => {
  const writeText = stubClipboard()
  const headers = { 'content-type': 'application/json' }
  render(<JsonTree value={{ headers }} />)

  await userEvent.click(screen.getByLabelText('Copy headers'))
  expect(writeText).toHaveBeenCalledWith(JSON.stringify(headers))

  await userEvent.click(screen.getByLabelText('Collapse headers'))
  await userEvent.click(screen.getByLabelText('Copy headers'))
  expect(writeText).toHaveBeenCalledWith(JSON.stringify(headers))
})

it('copies a collapsed embedded-JSON string as the raw string, not the parsed object', async () => {
  const writeText = stubClipboard()
  const raw = '{"userId":7}'
  render(<JsonTree value={{ body: raw }} />)

  await userEvent.click(screen.getByLabelText('Collapse body'))
  await userEvent.click(screen.getByLabelText('Copy body'))

  expect(writeText).toHaveBeenCalledWith(JSON.stringify(raw))
})

// A handler that returned nothing has no JSON to copy: JSON.stringify(undefined)
// is undefined, not a string.
it('renders no copy button for an undefined value', () => {
  render(<JsonTree value={undefined} />)

  expect(screen.queryByLabelText('Copy root')).not.toBeInTheDocument()
})

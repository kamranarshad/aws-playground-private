import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it } from 'vitest'

import { JsonTree } from '@/components/json-tree'

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
  expect(screen.queryByLabelText(/body/)).not.toBeInTheDocument()
})

it('renders a bare primitive response', () => {
  render(<JsonTree value="done" />)

  expect(screen.getByText('"done"')).toBeInTheDocument()
})

it('renders empty containers inline', () => {
  render(<JsonTree value={{ headers: {}, items: [] }} />)

  expect(screen.getByText('0 keys')).toBeInTheDocument()
  expect(screen.getByText('0 items')).toBeInTheDocument()
  expect(screen.queryByLabelText(/headers/)).not.toBeInTheDocument()
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

// Strings with quotes or newlines must not break out of their row.
it('escapes string values the way JSON does', () => {
  render(<JsonTree value={{ msg: 'say "hi"\nbye' }} />)

  expect(screen.getByText('"say \\"hi\\"\\nbye"')).toBeInTheDocument()
})

import { expect, test } from 'vitest'
import * as shared from '@aws-playground/shared'
import { RESULT_TABS } from './types'

test('RESULT_TABS is the shared package constant, not a copy', () => {
  expect(RESULT_TABS).toBe(shared.RESULT_TABS)
})

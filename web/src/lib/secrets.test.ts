import { expect, it } from 'vitest'
import { isSecretKey } from '@/lib/secrets'

it.each([
  'AWS_SECRET_ACCESS_KEY',
  'AWS_ACCESS_KEY_ID',
  'DB_PASSWORD',
  'PGPASSWORD',
  'API_TOKEN',
  'apiKey',
  'stripe_secret',
  'PRIVATE_KEY',
  'GITHUB_CREDENTIALS',
])('treats %s as secret', (key) => {
  expect(isSecretKey(key)).toBe(true)
})

it.each([
  'BUCKET_NAME',
  'AWS_REGION',
  'LOG_LEVEL',
  'KEYCLOAK_URL',
  'TOKENIZER_PATH',
  'NODE_ENV',
  '',
])('leaves %s in the clear', (key) => {
  expect(isSecretKey(key)).toBe(false)
})

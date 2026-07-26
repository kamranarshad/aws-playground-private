const SECRET_WORDS = [
  'SECRET', 'PASSWORD', 'PASSWD', 'TOKEN', 'KEY', 'CREDENTIAL', 'CREDENTIALS',
  'PRIVATE', 'SIGNATURE', 'PASSPHRASE',
]

// Split on separators AND camelCase humps, so `apiKey` and `API_KEY` are the
// same thing. Whole-token matching is what keeps KEYCLOAK_URL and
// TOKENIZER_PATH out of the net; the endsWith fallback catches run-together
// names like PGPASSWORD that have no separator to split on.
export function isSecretKey(key: string): boolean {
  const normalized = key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase()
  const tokens = normalized.split(/[^A-Z0-9]+/).filter(Boolean)
  return SECRET_WORDS.some(
    (word) => tokens.includes(word) || normalized.endsWith(word),
  )
}

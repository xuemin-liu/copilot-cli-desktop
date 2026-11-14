import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const {
  makeSessionRedactor,
  mergeExistingSensitiveFields,
} = require('../electron/ipc/sessions')

const SENSITIVE_FIELDS = ['password', 'passphrase', 'jumpPassword', 'jumpPassphrase']
const decryptSession = (session) => ({ ...session })

describe('session IPC redaction helpers', () => {
  it('removes credential fields while keeping presence flags', () => {
    const redact = makeSessionRedactor(decryptSession, SENSITIVE_FIELDS)

    const result = redact({
      id: 's1',
      host: 'example.com',
      password: 'secret',
      passphrase: '',
      jumpPassword: 'jump-secret',
    })

    expect(result).not.toHaveProperty('password')
    expect(result).not.toHaveProperty('jumpPassword')
    expect(result.hasPassword).toBe(true)
    expect(result.hasPassphrase).toBe(false)
    expect(result.hasJumpPassword).toBe(true)
  })

  it('preserves existing secrets when an edit omits secret fields', () => {
    const merged = mergeExistingSensitiveFields(
      { id: 's1', host: 'example.com', username: 'dev' },
      { id: 's1', password: 'saved', passphrase: 'saved-key' },
      decryptSession,
      SENSITIVE_FIELDS,
    )

    expect(merged.password).toBe('saved')
    expect(merged.passphrase).toBe('saved-key')
  })

  it('clears existing secrets when an edit sends an empty field explicitly', () => {
    const merged = mergeExistingSensitiveFields(
      { id: 's1', password: '' },
      { id: 's1', password: 'saved' },
      decryptSession,
      SENSITIVE_FIELDS,
    )

    expect(merged.password).toBe('')
  })
})

import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { SecureCredentialStore, secretEnvArgs, type EncryptionProvider } from './secure-credentials.js'

function fakeEncryption(available = true): EncryptionProvider {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (value) => Buffer.from(`enc:${value}`, 'utf8'),
    decryptString: (value) => value.toString('utf8').replace(/^enc:/, ''),
  }
}

async function withTempFile(run: (filename: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'copilot-desktop-credentials-'))
  try {
    await run(join(dir, 'protected-credentials.json'))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('status reports every credential as not configured on a fresh vault', async () => {
  await withTempFile(async (filename) => {
    const store = new SecureCredentialStore(filename, fakeEncryption())
    const status = await store.status()
    assert.equal(status.available, true)
    assert.equal(status.storeError, false)
    assert.deepEqual(status.entries.map((entry) => entry.configured), [false, false, false, false, false])
  })
})

test('saveCredential persists an encrypted record and resolveEnvironment decrypts it', async () => {
  await withTempFile(async (filename) => {
    const store = new SecureCredentialStore(filename, fakeEncryption())
    await store.saveCredential('COPILOT_PROVIDER_API_KEY', ' sk-test-value ')
    const environment = await store.resolveEnvironment()
    assert.equal(environment.COPILOT_PROVIDER_API_KEY, 'sk-test-value')

    const onDisk = JSON.parse(await readFile(filename, 'utf8')) as { credentials: Array<{ encryptedValue: string }> }
    assert.equal(onDisk.credentials.length, 1)
    assert.notEqual(onDisk.credentials[0]?.encryptedValue, 'sk-test-value')

    const status = await store.status()
    const entry = status.entries.find((candidate) => candidate.name === 'COPILOT_PROVIDER_API_KEY')
    assert.equal(entry?.configured, true)
    assert.equal(entry?.source, 'protected-store')
  })
})

test('saveCredential refuses to save when protected storage is unavailable', async () => {
  await withTempFile(async (filename) => {
    const store = new SecureCredentialStore(filename, fakeEncryption(false))
    await assert.rejects(() => store.saveCredential('GH_TOKEN', 'gho_test'), /unavailable/i)
  })
})

test('saveCredential rejects an empty secret', async () => {
  await withTempFile(async (filename) => {
    const store = new SecureCredentialStore(filename, fakeEncryption())
    await assert.rejects(() => store.saveCredential('GH_TOKEN', '   '))
  })
})

test('deleteCredential removes a saved record', async () => {
  await withTempFile(async (filename) => {
    const store = new SecureCredentialStore(filename, fakeEncryption())
    await store.saveCredential('GH_TOKEN', 'gho_test')
    await store.deleteCredential('GH_TOKEN')
    const status = await store.status()
    const entry = status.entries.find((candidate) => candidate.name === 'GH_TOKEN')
    assert.equal(entry?.configured, false)
  })
})

test('resolveEnvironment prefers an inherited environment value over a saved one', async () => {
  await withTempFile(async (filename) => {
    const store = new SecureCredentialStore(filename, fakeEncryption())
    await store.saveCredential('GH_TOKEN', 'gho_saved')
    const previous = process.env.GH_TOKEN
    process.env.GH_TOKEN = 'gho_inherited'
    try {
      const environment = await store.resolveEnvironment()
      assert.equal(environment.GH_TOKEN, undefined)
      const status = await store.status()
      const entry = status.entries.find((candidate) => candidate.name === 'GH_TOKEN')
      assert.equal(entry?.source, 'environment')
    } finally {
      if (previous === undefined) delete process.env.GH_TOKEN
      else process.env.GH_TOKEN = previous
    }
  })
})

test('writing an empty document removes the file entirely', async () => {
  await withTempFile(async (filename) => {
    const store = new SecureCredentialStore(filename, fakeEncryption())
    await store.saveCredential('GH_TOKEN', 'gho_test')
    await store.deleteCredential('GH_TOKEN')
    await assert.rejects(() => readFile(filename, 'utf8'), /ENOENT/)
  })
})

test('secretEnvArgs marks every configured credential variable present in the environment', () => {
  assert.deepEqual(
    secretEnvArgs({ GH_TOKEN: 'gho_test', COPILOT_PROVIDER_API_KEY: 'sk-test', COPILOT_GITHUB_TOKEN: 'github_pat_test' }),
    ['--secret-env-vars=COPILOT_PROVIDER_API_KEY', '--secret-env-vars=COPILOT_GITHUB_TOKEN', '--secret-env-vars=GH_TOKEN'],
  )
})

test('secretEnvArgs produces no flags when nothing is present', () => {
  assert.deepEqual(secretEnvArgs({}), [])
})

test('secretEnvArgs protects a credential that is only ambient (not vault-injected)', () => {
  // Simulates PtySession's merged `{ ...process.env, ...vaultEnvironment }`: a
  // variable already present in the parent process's own environment must be
  // protected exactly like one the vault decrypted, since Copilot receives
  // both the same way.
  assert.deepEqual(
    secretEnvArgs({ GH_TOKEN: 'gho_ambient', UNRELATED_VAR: 'x' } as NodeJS.ProcessEnv),
    ['--secret-env-vars=GH_TOKEN'],
  )
})

test('secretEnvArgs ignores an empty-string value', () => {
  assert.deepEqual(secretEnvArgs({ GH_TOKEN: '' }), [])
})

test('concurrent saveCredential calls for different variables do not clobber each other', async () => {
  await withTempFile(async (filename) => {
    const store = new SecureCredentialStore(filename, fakeEncryption())
    await Promise.all([
      store.saveCredential('GH_TOKEN', 'gho_a'),
      store.saveCredential('COPILOT_PROVIDER_API_KEY', 'sk_b'),
    ])
    const environment = await store.resolveEnvironment()
    assert.equal(environment.GH_TOKEN, 'gho_a')
    assert.equal(environment.COPILOT_PROVIDER_API_KEY, 'sk_b')
  })
})

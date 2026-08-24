import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/**
 * GitHub Copilot CLI's bring-your-own-key (BYOK) support reads
 * `COPILOT_PROVIDER_BASE_URL` and `COPILOT_PROVIDER_API_KEY` from the process
 * environment to override GitHub auth for model requests. `GH_TOKEN` is an
 * optional override for the `gh`/`copilot` GitHub authentication token. These
 * are the only three variables this vault manages.
 */
export type CredentialName = 'COPILOT_PROVIDER_BASE_URL' | 'COPILOT_PROVIDER_API_KEY' | 'GH_TOKEN'

export const CREDENTIAL_NAMES: readonly CredentialName[] = [
  'COPILOT_PROVIDER_BASE_URL',
  'COPILOT_PROVIDER_API_KEY',
  'GH_TOKEN',
]

export function isCredentialName(value: unknown): value is CredentialName {
  return typeof value === 'string' && (CREDENTIAL_NAMES as readonly string[]).includes(value)
}

export interface EncryptionProvider {
  isEncryptionAvailable(): boolean
  encryptString(value: string): Buffer
  decryptString(value: Buffer): string
}

interface CredentialRecord {
  name: CredentialName
  encryptedValue: string
}

interface CredentialDocument {
  version: 1
  credentials: CredentialRecord[]
}

const EMPTY_DOCUMENT: CredentialDocument = { version: 1, credentials: [] }
const MAX_SECRET_BYTES = 8_192

export interface CredentialStatusEntry {
  name: CredentialName
  configured: boolean
  source: 'environment' | 'protected-store' | 'none'
}

export interface CredentialStatus {
  available: boolean
  entries: CredentialStatusEntry[]
  storeError: boolean
}

async function writeAtomic(filename: string, contents: string): Promise<void> {
  await mkdir(dirname(filename), { recursive: true, mode: 0o700 })
  const temporary = `${filename}.${process.pid}.${Date.now()}.tmp`
  try {
    await writeFile(temporary, contents, { encoding: 'utf8', mode: 0o600 })
    await rename(temporary, filename)
  } finally {
    await rm(temporary, { force: true }).catch(() => {})
  }
}

/**
 * DPAPI-backed (via Electron `safeStorage`) vault for the three Copilot BYOK
 * environment overrides. If protected storage is unavailable, every save is
 * refused outright rather than silently falling back to plaintext.
 */
export class SecureCredentialStore {
  constructor(
    private readonly filename: string,
    private readonly encryption: EncryptionProvider,
  ) {}

  isAvailable(): boolean {
    return this.encryption.isEncryptionAvailable()
  }

  private async readDocument(): Promise<CredentialDocument> {
    let parsed: unknown
    try {
      parsed = JSON.parse(await readFile(this.filename, 'utf8')) as unknown
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ...EMPTY_DOCUMENT }
      throw error
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('The protected credential file has an unsupported format')
    }
    const value = parsed as Record<string, unknown>
    if (value.version !== 1 || !Array.isArray(value.credentials)) {
      throw new Error('The protected credential file has an unsupported format')
    }
    const credentials: CredentialRecord[] = []
    for (const candidate of value.credentials) {
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
        throw new Error('The protected credential file has an unsupported format')
      }
      const record = candidate as Record<string, unknown>
      if (
        !isCredentialName(record.name)
        || typeof record.encryptedValue !== 'string'
        || record.encryptedValue.length === 0
      ) {
        throw new Error('The protected credential file has an unsupported format')
      }
      if (credentials.some((entry) => entry.name === record.name)) {
        throw new Error('The protected credential file contains duplicate variables')
      }
      credentials.push({ name: record.name, encryptedValue: record.encryptedValue })
    }
    return { version: 1, credentials }
  }

  private async writeDocument(document: CredentialDocument): Promise<void> {
    if (document.credentials.length === 0) {
      await rm(this.filename, { force: true })
      return
    }
    await writeAtomic(this.filename, `${JSON.stringify(document, null, 2)}\n`)
  }

  async status(): Promise<CredentialStatus> {
    let document = EMPTY_DOCUMENT
    let storeError = false
    try {
      document = await this.readDocument()
    } catch {
      storeError = true
    }
    const byName = new Map(document.credentials.map((record) => [record.name, record]))
    const entries = CREDENTIAL_NAMES.map((name): CredentialStatusEntry => {
      const environmentValue = process.env[name]
      if (typeof environmentValue === 'string' && environmentValue.length > 0) {
        return { name, configured: true, source: 'environment' }
      }
      if (byName.has(name)) return { name, configured: true, source: 'protected-store' }
      return { name, configured: false, source: 'none' }
    })
    return { available: this.isAvailable(), entries, storeError }
  }

  async saveCredential(name: CredentialName, secret: string): Promise<void> {
    if (!isCredentialName(name)) throw new Error('Unsupported credential variable')
    const normalizedSecret = secret.trim()
    if (!normalizedSecret) throw new Error('Enter a non-empty value')
    if (Buffer.byteLength(normalizedSecret, 'utf8') > MAX_SECRET_BYTES) {
      throw new Error('The credential is unexpectedly large')
    }
    if (!this.isAvailable()) {
      throw new Error('Windows protected storage is unavailable; the credential was not saved')
    }
    let document: CredentialDocument
    try {
      document = await this.readDocument()
    } catch {
      const backup = `${this.filename}.corrupt-${Date.now()}`
      await rename(this.filename, backup)
      document = { ...EMPTY_DOCUMENT }
    }
    const record: CredentialRecord = {
      name,
      encryptedValue: this.encryption.encryptString(normalizedSecret).toString('base64'),
    }
    document.credentials = [
      ...document.credentials.filter((candidate) => candidate.name !== name),
      record,
    ].sort((left, right) => left.name.localeCompare(right.name))
    await this.writeDocument(document)
  }

  async deleteCredential(name: CredentialName): Promise<void> {
    if (!isCredentialName(name)) throw new Error('Unsupported credential variable')
    const document = await this.readDocument()
    document.credentials = document.credentials.filter((record) => record.name !== name)
    await this.writeDocument(document)
  }

  /**
   * Resolve the environment overrides to inject into a spawned pty session.
   * An inherited process environment value always takes precedence over a
   * saved protected value. Never expose the return value to a renderer.
   */
  async resolveEnvironment(): Promise<Partial<Record<CredentialName, string>>> {
    const document = await this.readDocument()
    if (document.credentials.length > 0 && !this.isAvailable()) {
      throw new Error('Windows protected storage is unavailable in this session')
    }
    const environment: Partial<Record<CredentialName, string>> = {}
    for (const record of document.credentials) {
      const inherited = process.env[record.name]
      if (typeof inherited === 'string' && inherited.length > 0) continue
      environment[record.name] = this.encryption.decryptString(Buffer.from(record.encryptedValue, 'base64'))
    }
    return environment
  }
}

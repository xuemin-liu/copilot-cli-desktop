import { readFile, rm } from 'node:fs/promises'
import { quarantineCorruptFile, writeFileAtomic } from './atomic-file.js'

/**
 * GitHub Copilot CLI's bring-your-own-key (BYOK) support reads
 * provider and GitHub authentication variables from the process environment.
 * The vault covers every credential-bearing variable in the official CLI
 * precedence chain while provider type, endpoint, model, and offline mode are
 * stored as non-secret desktop settings.
 */
export type CredentialName =
  | 'COPILOT_PROVIDER_BASE_URL'
  | 'COPILOT_PROVIDER_API_KEY'
  | 'COPILOT_GITHUB_TOKEN'
  | 'GH_TOKEN'
  | 'GITHUB_TOKEN'

export const CREDENTIAL_NAMES: readonly CredentialName[] = [
  'COPILOT_PROVIDER_BASE_URL',
  'COPILOT_PROVIDER_API_KEY',
  'COPILOT_GITHUB_TOKEN',
  'GH_TOKEN',
  'GITHUB_TOKEN',
]

export function isCredentialName(value: unknown): value is CredentialName {
  return typeof value === 'string' && (CREDENTIAL_NAMES as readonly string[]).includes(value)
}

const SENSITIVE_ENVIRONMENT_NAME = /(?:API_?KEY|TOKEN|SECRET|PASSWORD|PASSWD|PRIVATE_?KEY|ACCESS_?KEY|CREDENTIALS?|AUTHORIZATION)/i

export function sensitiveEnvironmentNames(environment: NodeJS.ProcessEnv): string[] {
  return Object.keys(environment)
    .filter((name) => typeof environment[name] === 'string' && environment[name]!.length > 0)
    .filter((name) => isCredentialName(name.toUpperCase()) || SENSITIVE_ENVIRONMENT_NAME.test(name))
    .sort((left, right) => left.localeCompare(right))
}

/** Remove credentials before spawning helpers that do not need authentication. */
export function withoutSensitiveEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result = { ...environment }
  for (const name of sensitiveEnvironmentNames(result)) delete result[name]
  return result
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

/**
 * DPAPI-backed (via Electron `safeStorage`) vault for the three Copilot BYOK
 * environment overrides. If protected storage is unavailable, every save is
 * refused outright rather than silently falling back to plaintext.
 */
export class SecureCredentialStore {
  private mutationQueue: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly filename: string,
    private readonly encryption: EncryptionProvider,
  ) {}

  isAvailable(): boolean {
    return this.encryption.isEncryptionAvailable()
  }

  /**
   * saveCredential/deleteCredential each do read-modify-write against the
   * same file. Two concurrent calls (e.g. saving two different variables in
   * quick succession from the settings UI) can otherwise both read the same
   * starting document, apply their own change, and write it back — the
   * second write silently discards the first credential's update. Queue the
   * whole transaction per store instance so writes are serialized.
   */
  private enqueueMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationQueue.then(operation)
    this.mutationQueue = result.then(() => undefined, () => undefined)
    return result
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
    await writeFileAtomic(this.filename, `${JSON.stringify(document, null, 2)}\n`)
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
    await this.enqueueMutation(async () => {
      let document: CredentialDocument
      try {
        document = await this.readDocument()
      } catch {
        await quarantineCorruptFile(this.filename)
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
    })
  }

  async deleteCredential(name: CredentialName): Promise<void> {
    if (!isCredentialName(name)) throw new Error('Unsupported credential variable')
    await this.enqueueMutation(async () => {
      const document = await this.readDocument()
      document.credentials = document.credentials.filter((record) => record.name !== name)
      await this.writeDocument(document)
    })
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

/**
 * Copilot CLI's `--secret-env-vars=<NAME>` flag keeps a named environment
 * variable available to the top-level `copilot` process (so it can still
 * authenticate) while withholding it from shell commands and MCP servers the
 * agent spawns.
 *
 * This takes the FULL environment a session is about to receive — not just
 * the subset resolved from the vault — because `PtySession` always merges
 * `process.env` into that environment (see pty-session.ts). A credential
 * that was already present ambiently (inherited from whatever launched the
 * desktop or the background daemon) reaches Copilot exactly the same way a
 * vault-decrypted one does, so it needs the same protection. Keying
 * protection off "did the vault inject this" instead of "is this credential
 * name present at all" would leave ambient credentials exposed to tool
 * descendants.
 */
export function secretEnvArgs(mergedEnvironment: NodeJS.ProcessEnv): string[] {
  return sensitiveEnvironmentNames(mergedEnvironment)
    .map((name) => `--secret-env-vars=${name}`)
}

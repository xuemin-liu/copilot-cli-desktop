import { createHash } from 'node:crypto'
import { lstat, readdir, readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { parse, type ParseError } from 'jsonc-parser'
import { readDesktopConfig } from './desktop-config.js'
import { SENSITIVE_ENVIRONMENT_NAME } from './secure-credentials.js'
import type { MigrationCategory, MigrationEntry, MigrationManifest, MigrationRoots } from './migration-types.js'

export const MAX_MIGRATION_FILE = 64 * 1024 * 1024
export const MAX_MIGRATION_BYTES = 256 * 1024 * 1024
export const MAX_MIGRATION_ENTRIES = 10_000
export interface MigrationFile extends MigrationEntry { data: Buffer }
export const digest = (data: Buffer): string => createHash('sha256').update(data).digest('hex')
export const jsonBytes = (value: unknown): Buffer => Buffer.from(`${JSON.stringify(value, null, 2)}\n`)
export function jsonObject(data: Buffer): Record<string, unknown> {
  const errors: ParseError[] = []
  const result: unknown = parse(data.toString('utf8'), errors, { allowTrailingComma: true })
  if (errors.length || !result || typeof result !== 'object' || Array.isArray(result)) throw new Error('Invalid JSON/JSONC configuration')
  return result as Record<string, unknown>
}
export function safeRelative(path: string): void {
  if (!path || path.length > 1024 || /[\\:<>"|?*\x00-\x1f]/.test(path)
    || path.split('/').some((part) => !part || part === '.' || part === '..' || /[. ]$/.test(part)
      || /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/i.test(part))) throw new Error('Unsafe archive path')
}
export async function assertNoLinks(path: string): Promise<void> {
  let current = resolve(path)
  for (;;) {
    try { if ((await lstat(current)).isSymbolicLink()) throw new Error(`Links and junctions are unsupported: ${current}`) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    const parent = dirname(current)
    if (parent === current) return
    current = parent
  }
}
export async function optionalRead(path: string): Promise<Buffer | null> {
  await assertNoLinks(path)
  try {
    const before = await lstat(path)
    if (!before.isFile() || before.size > MAX_MIGRATION_FILE) throw new Error(`Unsupported or oversized file: ${path}`)
    const data = await readFile(path)
    const after = await lstat(path)
    if (data.length > MAX_MIGRATION_FILE || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== after.ino) throw new Error(`File changed during migration: ${path}`)
    return data
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
}

// Explicit support avoids activating unknown future settings or legacy application state.
const SETTINGS = new Set(['model', 'theme', 'banner', 'autoUpdate', 'autoUpdatesChannel', 'streamerMode', 'screenReader',
  'renderMarkdown', 'logLevel', 'experimental', 'reasoningEffort', 'contextTier', 'askUser', 'companyAnnouncements',
  'defaultPermissionMode', 'allowedUrls', 'hooks', 'disableAllHooks', 'enabledPlugins', 'extraKnownMarketplaces',
  'customInstructionsDirectories', 'skillDirectories', 'bashEnv', 'beep', 'beepOnSchedule', 'builtInAgents.rubberDuck',
  'builtInAgents.rubberDuckAutoInvoke', 'colorMode', 'commandHistoryMaxSize', 'compactPaste', 'continueOnAutoMode',
  'copyOnSelect', 'customAgents.defaultLocalOnly', 'deniedUrls', 'disabledMcpServers', 'disabledSkills', 'dynamicRetrieval',
  'effortLevel', 'enabledMcpServers', 'footer', 'ide.autoConnect', 'ide.openDiffOnEdit', 'includeCoAuthoredBy', 'keepAlive',
  'mergeStrategy', 'mouse', 'permissions.disableBypassPermissionsMode', 'pinnedPrompts', 'powershellFlags',
  'proxyKerberosServicePrincipal', 'proxyUrl', 'remote', 'renderHexColors', 'remoteExport', 'respectGitignore',
  'sandbox.allowBypass', 'sandbox.enabled', 'sandbox.auth.git', 'sandbox.auth.gh', 'sandbox.userPolicy.network.allowLocalNetwork',
  'sandbox.userPolicy.deniedPaths', 'scrollbar', 'shellShortcut', 'showTimestamps', 'showTipsOnStartup', 'statusLine',
  'stayInAutopilot', 'stream', 'subagents.agents', 'subagents.disabledSubagents', 'subagents.maxConcurrency', 'subagents.maxDepth',
  'tabs.enabled', 'tabs.hide', 'tabs.sort', 'terminalProgress', 'toolSearch', 'updateTerminalTitle', 'worktreeBaseRef'])
export const permissionSetting = (key: string): boolean => /permission|allowed|denied|trusted|sandbox|bypass|remote|autopilot/i.test(key) || ['askUser', 'continueOnAutoMode'].includes(key)
export const executableSetting = (key: string): boolean => ['hooks', 'disableAllHooks', 'enabledPlugins', 'extraKnownMarketplaces', 'statusLine', 'powershellFlags', 'bashEnv', 'enabledMcpServers'].includes(key)
const secretKey = new RegExp(`${SENSITIVE_ENVIRONMENT_NAME.source}|base.?url`, 'i')
function reference(value: unknown): boolean { return typeof value === 'string' && /^\$\{(?:env:)?[A-Za-z_][A-Za-z0-9_]*\}$/.test(value) }
export function sanitize(value: unknown, warnings: string[], depth = 0): unknown {
  if (depth > 40) throw new Error('Configuration nesting exceeds migration limit')
  if (Array.isArray(value)) return value.map((item) => sanitize(item, warnings, depth + 1))
  if (!value || typeof value !== 'object') {
    if (typeof value === 'string' && /^https?:\/\//i.test(value)) {
      try {
        const url = new URL(value)
        if (url.username || url.password || url.search) { url.username = ''; url.password = ''; url.search = ''; warnings.push('Removed URL credentials/query parameters; reconnect the affected service.'); return url.href }
      } catch { /* Non-URL values are copied as user text. */ }
    }
    return value
  }
  const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>
  for (const [key, item] of Object.entries(value)) {
    if (['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error('Unsupported configuration key')
    if ((secretKey.test(key) || key === 'env' || key === 'headers') && !reference(item)) {
      if ((key === 'env' || key === 'headers') && item && typeof item === 'object' && !Array.isArray(item)) {
        output[key] = Object.fromEntries(Object.entries(item).filter(([, v]) => reference(v)))
      }
      warnings.push(`Reconnect configuration field: ${key}`)
    } else output[key] = sanitize(item, warnings, depth + 1)
  }
  return output
}
export function portableSettings(data: Buffer, warnings: string[], includeTools = false, prefix = ''): Buffer {
  const values = jsonObject(data)
  const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>
  for (const [key, value] of Object.entries(values)) {
    const fullKey = prefix ? `${prefix}.${key}` : key
    if (!SETTINGS.has(fullKey)) {
      if ([...SETTINGS].some((name) => name.startsWith(`${fullKey}.`)) && value && typeof value === 'object' && !Array.isArray(value)) output[key] = jsonObject(portableSettings(jsonBytes(value), warnings, includeTools, fullKey))
      else warnings.push(`Unsupported setting omitted: ${fullKey}`)
      continue
    }
    if (!includeTools && executableSetting(key)) { warnings.push(`Executable setting omitted: ${key} (select Tools to include)`); continue }
    output[key] = value
    if (/Directories$/.test(key)) warnings.push(`Review external paths in ${key}; external directories are not copied automatically.`)
  }
  return jsonBytes(sanitize(output, warnings))
}
export async function portableDesktop(path: string): Promise<Buffer> {
  await optionalRead(path) // Apply the same link, type and size checks as other sources.
  const config = await readDesktopConfig(path)
  return jsonBytes({ closeBehavior: config.closeBehavior, trayEnabled: config.trayEnabled, notifications: config.notifications,
    automaticUpdateChecks: config.automaticUpdateChecks, globalShortcutEnabled: config.globalShortcutEnabled,
    provider: { type: config.provider.type, model: config.provider.model, offline: config.provider.offline },
    profiles: config.profiles.map(({ name, path: profilePath, permissionPreset, defaultResumeMode, launch, tabs }) =>
      ({ name, path: profilePath, permissionPreset, defaultResumeMode, launch, tabs })) })
}
export function fileEntry(path: string, category: MigrationCategory, data: Buffer): MigrationFile {
  safeRelative(path)
  return { path, category, size: data.length, sha256: digest(data), data }
}
export const PROJECT_FILES = ['.github/copilot-instructions.md', '.github/instructions', '.github/skills', '.github/agents',
  '.github/hooks', '.github/copilot/settings.json', 'AGENTS.md', '.agents/skills', '.claude/skills']
export const isCliSettingsPath = (path: string): boolean => path === 'copilot/settings.json' || /^projects\/[a-f0-9]{16}\/\.github\/copilot\/settings\.json$/.test(path)
export const isToolConfigPath = (path: string): boolean => ['copilot/mcp-config.json', 'copilot/lsp-config.json'].includes(path)
export const isToolJsonPath = (path: string): boolean => /\.jsonc?$/i.test(path) && (/^copilot\/(?:hooks|extensions)\//.test(path) || /^projects\/[a-f0-9]{16}\/\.github\/hooks\//.test(path))
/** Arrays and scalars are legitimate tool assets. Only syntax failures are opaque. */
export function transformToolJson(data: Buffer, path: string, warnings: string[], transform: (value: unknown) => unknown): Buffer {
  const errors: ParseError[] = []
  const value: unknown = parse(data.toString('utf8'), errors, { allowTrailingComma: true })
  if (errors.length || value === undefined) {
    warnings.push(`Unparsed tool asset preserved without secret filtering or path remapping; review manually: ${path}`)
    return data
  }
  const transformed = transform(value)
  // Always serialize: comments and shadowed duplicate keys were not sanitized.
  return jsonBytes(transformed)
}
export function migrationAssetGroup(path: string): string | null {
  const match = /^(copilot\/(?:skills|agents)|agents-home\/skills|projects\/[a-f0-9]{16}\/(?:\.github\/(?:skills|agents)|\.agents\/skills|\.claude\/skills))\/([^/]+)(?:\/|$)/.exec(path)
  return match && path.startsWith(`${match[1]}/${match[2]}/`) ? `${match[1]}/${match[2]}` : null
}
export function isUnavailableMigrationPath(error: unknown): boolean { return ['ENOENT', 'ENOTDIR', 'EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '') }
export async function collectMigration(roots: MigrationRoots, manifest: MigrationManifest, categories: ReadonlySet<MigrationCategory>, signal?: AbortSignal,
  readDirectory = (path: string) => readdir(path, { withFileTypes: true })): Promise<MigrationFile[]> {
  const files: MigrationFile[] = []
  let total = 0
  let visited = 0
  const add = (file: MigrationFile): void => {
    total += file.size
    if (files.length >= MAX_MIGRATION_ENTRIES || total > MAX_MIGRATION_BYTES) throw new Error('Migration exceeds 10,000 files or 256 MiB')
    files.push(file)
  }
  async function tolerate(path: string, operation: () => Promise<void>): Promise<void> {
    const start = files.length, bytes = total
    try { await operation() }
    catch (error) {
      if (!isUnavailableMigrationPath(error)) throw error
      // Never publish a partial asset group: replacement deletes absent files.
      files.splice(start); total = bytes
      manifest.warnings.push(`Skipped entire unavailable path: ${path}. Restore access to this path, then review again.`)
    }
  }
  const collectPath = (source: string, archive: string, category: MigrationCategory): Promise<void> => tolerate(source, async () => {
    // Optional roots may never have existed. Disappearance after discovery is different.
    try { await lstat(source) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
    await walk(source, archive, category)
  })
  async function walk(source: string, archive: string, category: MigrationCategory): Promise<void> {
    signal?.throwIfAborted()
    if (++visited > 20_000 || archive.split('/').length > 40) throw new Error('Migration directory scan limit exceeded')
    await assertNoLinks(source)
    let info
    info = await lstat(source)
    if (info.isDirectory()) {
      for (const child of (await readDirectory(source)).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
        const childSource = join(source, child.name), childArchive = `${archive}/${child.name}`
        if (migrationAssetGroup(`${childArchive}/`) === childArchive) await tolerate(childSource, () => walk(childSource, childArchive, category))
        else await walk(childSource, childArchive, category)
      }
    } else {
      let data = await optionalRead(source)
      if (!data) throw Object.assign(new Error(`Source disappeared: ${source}`), { code: 'ENOENT' })
      try {
        if (isCliSettingsPath(archive)) data = portableSettings(data, manifest.warnings, categories.has('tools'))
        else if (isToolConfigPath(archive)) data = jsonBytes(sanitize(jsonObject(data), manifest.warnings))
        else if (isToolJsonPath(archive)) data = transformToolJson(data, archive, manifest.warnings, (value) => sanitize(value, manifest.warnings))
      } catch { throw new Error(`Invalid migration configuration: ${source}`) }
      add(fileEntry(archive, category, data))
    }
  }
  if (categories.has('settings')) {
    const settings = await optionalRead(join(roots.copilot, 'settings.json')) ?? await optionalRead(join(roots.copilot, 'config.json'))
    if (settings) add(fileEntry('copilot/settings.json', 'settings', portableSettings(settings, manifest.warnings, categories.has('tools'))))
  }
  if (categories.has('knowledge')) for (const path of ['copilot-instructions.md', 'instructions']) await collectPath(join(roots.copilot, path), `copilot/${path}`, 'knowledge')
  if (categories.has('skills')) {
    for (const path of ['skills', 'agents']) await collectPath(join(roots.copilot, path), `copilot/${path}`, 'skills')
    await collectPath(roots.agentSkills, 'agents-home/skills', 'skills')
  }
  if (categories.has('tools')) for (const path of ['mcp-config.json', 'lsp-config.json', 'hooks', 'extensions']) await collectPath(join(roots.copilot, path), `copilot/${path}`, 'tools')
  if (categories.has('desktop')) add(fileEntry('desktop/preferences.json', 'desktop', await portableDesktop(join(roots.desktop, 'desktop.json'))))
  if (categories.has('projects')) for (const project of manifest.projects) {
    for (const path of PROJECT_FILES) {
      if (path === '.github/hooks' && !categories.has('tools')) continue
      const source = join(project.sourcePath, path)
      await collectPath(source, `projects/${project.id}/${path}`, 'projects')
    }
    // Traverse names only, never follow links or walk repository internals/dependencies.
    let visited = 0
    async function instructions(root: string, relative: string, depth: number): Promise<void> {
      signal?.throwIfAborted()
      if (++visited > 20_000 || depth > 30) { manifest.warnings.push(`Nested AGENTS.md scan limit reached in ${project.name}.`); return }
      let entries: Awaited<ReturnType<typeof readDirectory>> | undefined
      await tolerate(root, async () => { await assertNoLinks(root); entries = await readDirectory(root) })
      if (!entries) return
      for (const entry of entries) {
        if (entry.isSymbolicLink() || ['.git', 'node_modules', '.github', '.agents', '.claude', 'dist', 'build', 'release', '.venv'].includes(entry.name)) continue
        const rel = relative ? `${relative}/${entry.name}` : entry.name
        if (entry.isDirectory()) await instructions(join(root, entry.name), rel, depth + 1)
        else if (entry.name === 'AGENTS.md' && relative) {
          await collectPath(join(root, entry.name), `projects/${project.id}/${rel}`, 'projects')
        }
      }
    }
    await instructions(project.sourcePath, '', 0)
  }
  manifest.warnings = [...new Set(manifest.warnings)].slice(0, 999)
  return files
}

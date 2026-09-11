import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import yazl from 'yazl'
import { DEFAULT_DESKTOP_CONFIG, normalizeDesktopConfig, readDesktopConfig, workspaceProfileId } from './desktop-config.js'
import { applyMigrationImport, planMigrationImport, recoverMigrationImports } from './migration-import.js'
import { collectMigration, digest, fileEntry, jsonBytes, jsonObject, portableSettings, safeRelative } from './migration-inventory.js'
import { readMigrationArchive, writeMigrationArchive, type MigrationArchive } from './migration-archive.js'
import { MigrationService } from './migration-service.js'
import { assertMigrationWritersStopped } from './migration-writers.js'
import { CREDENTIAL_NAMES, SENSITIVE_ENVIRONMENT_NAME } from './secure-credentials.js'
import type { DaemonState } from '../cli/runtime-state.js'
import type { MigrationChoices, MigrationManifest, MigrationRoots } from './migration-types.js'

const choices: MigrationChoices = { categories: ['settings', 'knowledge', 'skills', 'desktop', 'projects', 'tools'], replace: [], allowPermissions: false }
function manifest(): MigrationManifest { return { version: 1, createdAt: new Date().toISOString(), platform: 'win32', appVersion: '0.1.17', cliVersion: '1.0.82', projects: [], entries: [], warnings: [] } }
async function fixture(t: { after: (fn: () => Promise<void>) => void }): Promise<{ root: string; source: MigrationRoots; target: MigrationRoots }> {
  const root = await mkdtemp(join(tmpdir(), 'migration-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const roots = (name: string): MigrationRoots => ({ copilot: join(root, name, 'custom-copilot'), agentSkills: join(root, name, 'home', '.agents', 'skills'), desktop: join(root, name, 'desktop') })
  const source = roots('A'), target = roots('B')
  for (const path of [...Object.values(source), ...Object.values(target)]) await mkdir(path, { recursive: true })
  return { root, source, target }
}
async function put(path: string, data: string | Buffer): Promise<void> { await mkdir(join(path, '..'), { recursive: true }); await writeFile(path, data) }
const archive = (...files: MigrationArchive['files']): MigrationArchive => ({ manifest: manifest(), files })

test('provider replacements retain the destination endpoint and unselected fields', async (t) => {
  const { target } = await fixture(t)
  await put(join(target.desktop, 'desktop.json'), jsonBytes({ provider: { type: 'openai', baseUrl: 'https://local.test/v1', model: 'old', offline: true } }))
  const data = archive(fileEntry('desktop/preferences.json', 'desktop', jsonBytes({ provider: { model: 'new', baseUrl: 'https://imported.test/SECRET' } })))
  const plan = await planMigrationImport(data, target, {}, { ...choices, replace: ['desktop/preferences.json#provider.model'] })
  assert.deepEqual(plan.preview.changes.map((c) => c.id), ['desktop/preferences.json#provider.model'])
  await applyMigrationImport(plan, target)
  assert.deepEqual((await readDesktopConfig(join(target.desktop, 'desktop.json'))).provider, { type: 'openai', baseUrl: 'https://local.test/v1', model: 'new', offline: true })
})

test('opaque JSON assets round trip unchanged while exact CLI and tool configurations are filtered', async (t) => {
  const { source, target } = await fixture(t)
  const assets = { 'skills/demo/settings.json': '{"arbitrary":true}', 'extensions/demo/settings.json': '[1,2]', 'extensions/demo/scalar.json': 'false', 'hooks/settings.json': '{not json}', 'skills/demo/ref.json': '{"TOKEN":"private asset"}' }
  for (const [path, bytes] of Object.entries(assets)) await put(join(source.copilot, path), bytes)
  await put(join(source.copilot, 'settings.json'), '{"model":"allowed","arbitrary":true}')
  const files = await collectMigration(source, manifest(), new Set(choices.categories))
  await applyMigrationImport(await planMigrationImport(archive(...files), target, {}, choices), target)
  for (const [path, bytes] of Object.entries(assets)) assert.equal(await readFile(join(target.copilot, path), 'utf8'), bytes)
  assert.deepEqual(jsonObject(await readFile(join(target.copilot, 'settings.json'))), { model: 'allowed' })
})

test('all credential-vault key families are removed from tool definitions but references survive', async (t) => {
  const { source, target } = await fixture(t)
  const keys = [...CREDENTIAL_NAMES, 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'PRIVATE_KEY', 'ACCESS_KEY', 'SIGNING_KEY', 'AUTH', 'AUTHORIZATION', 'PASSWORD', 'CLIENT_SECRET']
  for (const key of keys.filter((key) => key !== 'COPILOT_PROVIDER_BASE_URL')) assert.ok(SENSITIVE_ENVIRONMENT_NAME.test(key), key)
  const env = Object.fromEntries(keys.map((key) => [key, 'literal-secret']))
  await put(join(source.copilot, 'mcp-config.json'), jsonBytes({ mcpServers: { demo: { ...env, command: 'node', PUBLIC_MODE: 'enabled', env: { ...env, REF_API_KEY: '${API_KEY}' } } } }))
  const files = await collectMigration(source, manifest(), new Set(['tools']))
  assert.ok(!files[0]!.data.includes('literal-secret'))
  await applyMigrationImport(await planMigrationImport(archive(...files), target, {}, choices), target)
  assert.deepEqual(JSON.parse(await readFile(join(target.copilot, 'mcp-config.json'), 'utf8')).mcpServers.demo, { command: 'node', PUBLIC_MODE: 'enabled', env: { REF_API_KEY: '${API_KEY}' } })
})

test('unavailable projects and denied nested directories warn and retain readable inventory', async (t) => {
  const { root, source } = await fixture(t)
  const repo = join(root, 'repo'), denied = join(repo, 'denied')
  await mkdir(denied, { recursive: true }); await put(join(repo, 'readable/AGENTS.md'), 'keep')
  const info = manifest()
  info.projects = [{ id: 'aaaaaaaaaaaaaaaa', name: 'missing', sourcePath: join(root, 'disconnected') }, { id: 'bbbbbbbbbbbbbbbb', name: 'repo', sourcePath: repo }]
  const files = await collectMigration(source, info, new Set(['projects']), undefined, async (path) => {
    if (path === denied) throw Object.assign(new Error('Denied'), { code: 'EACCES' })
    return readdir(path, { withFileTypes: true })
  })
  assert.ok(files.some((f) => f.path.endsWith('readable/AGENTS.md')))
  assert.ok(info.warnings.some((w) => w.includes(denied)))
  assert.ok(info.warnings.some((w) => w.includes('disconnected')))
})

test('normalized profile previews match writes and repeat as identical without staging files', async (t) => {
  const { root, target } = await fixture(t)
  const workspace = join(root, 'repo'); await mkdir(workspace)
  const id = 'aaaaaaaaaaaaaaaa'
  const data = archive(fileEntry('desktop/preferences.json', 'desktop', jsonBytes({ profiles: [{ path: 'C:\\old', name: `  ${'x'.repeat(130)}  `, permissionPreset: 'invalid' }] })))
  data.manifest.projects = [{ id, sourcePath: 'C:\\old', name: 'project' }]
  const plan = await planMigrationImport(data, target, { [id]: workspace }, { ...choices, allowPermissions: true })
  assert.deepEqual(await readdir(target.desktop), [])
  const normalized = normalizeDesktopConfig({ profiles: [{ path: workspace, name: 'x'.repeat(100), permissionPreset: 'default', defaultResumeMode: 'new' }] })
  assert.ok(plan.preview.changes[0]!.detail.includes(JSON.stringify(normalized.profiles[0])))
  await applyMigrationImport(plan, target)
  const saved = JSON.parse(await readFile(join(target.desktop, 'desktop.json'), 'utf8'))
  saved.profiles[0] = Object.fromEntries(Object.entries(saved.profiles[0]).reverse())
  await put(join(target.desktop, 'desktop.json'), jsonBytes(saved))
  const repeat = await planMigrationImport(data, target, { [id]: workspace }, { ...choices, allowPermissions: true })
  assert.equal(repeat.writes.length, 0)
  assert.equal(repeat.preview.changes[0]!.status, 'Identical')
})

test('permission opt-in controls CLI prompting settings and workspace execution choices', async (t) => {
  const { root, target } = await fixture(t)
  const workspace = join(root, 'repo'); await mkdir(workspace)
  const id = 'aaaaaaaaaaaaaaaa'
  const settings = { askUser: false, continueOnAutoMode: true, defaultPermissionMode: 'autopilot' }
  const data = archive(fileEntry('copilot/settings.json', 'settings', jsonBytes(settings)), fileEntry('desktop/preferences.json', 'desktop', jsonBytes({ profiles: [{ path: 'C:\\old', name: 'repo', permissionPreset: 'full-access', launch: { mode: 'autopilot', remoteControl: 'enable', remoteExport: 'enable' } }] })))
  data.manifest.projects = [{ id, sourcePath: 'C:\\old', name: 'repo' }]
  for (const allowPermissions of [false, true]) {
    const plan = await planMigrationImport(data, target, { [id]: workspace }, { ...choices, allowPermissions })
    const settingWrite = plan.writes.find((w) => w.target.endsWith('settings.json'))
    assert.deepEqual(settingWrite ? jsonObject(settingWrite.data!) : {}, allowPermissions ? settings : {})
    const desktop = normalizeDesktopConfig(jsonObject(plan.writes.find((w) => w.target.endsWith('desktop.json'))!.data!))
    assert.equal(desktop.profiles[0]!.permissionPreset, allowPermissions ? 'full-access' : 'default')
    assert.equal(desktop.profiles[0]!.launch.mode, allowPermissions ? 'autopilot' : 'interactive')
    assert.equal(desktop.profiles[0]!.launch.remoteControl, allowPermissions ? 'enable' : 'inherit')
    assert.equal(desktop.profiles[0]!.launch.remoteExport, allowPermissions ? 'enable' : 'inherit')
  }
})

test('recovery reports corrupt journals and missing backups without preventing startup', async (t) => {
  const { target, root } = await fixture(t)
  const destination = join(target.copilot, 'copilot-instructions.md')
  const directory = join(target.desktop, 'migration-backups', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')
  await put(join(directory, 'journal.json'), '{broken')
  assert.match((await recoverMigrationImports(target.desktop)).join(), /needs attention/)
  await put(destination, 'after')
  await put(join(directory, 'journal.json'), jsonBytes({ version: 1, status: 'pending', roots: [target.copilot], writes: [{ target: destination, before: digest(Buffer.from('before')), after: digest(Buffer.from('after')) }] }))
  assert.match((await recoverMigrationImports(target.desktop)).join(), /missing or damaged/)
  await put(join(directory, '0.bak'), 'before')
  assert.equal((await recoverMigrationImports(target.desktop)).length, 1)
  assert.deepEqual(await recoverMigrationImports(target.desktop, true), [])
  assert.equal(await readFile(destination, 'utf8'), 'before')
  const redirected = join(root, 'redirected'), empty = join(root, 'empty')
  await mkdir(empty); await symlink(empty, redirected, 'junction')
  assert.deepEqual(await recoverMigrationImports(redirected), [])
})

test('writer checks use authenticated daemon state and ignore stale process identities', async () => {
  const state = { pid: process.pid } as DaemonState
  let queried = false
  await assertMigrationWritersStopped({ readState: async () => null, isAlive: async () => { queried = true; return true } })
  assert.equal(queried, false)
  await assertMigrationWritersStopped({ readState: async () => state, isAlive: async (candidate) => { assert.equal(candidate, state); return false } })
  await assert.rejects(assertMigrationWritersStopped({ readState: async () => state, isAlive: async () => true }), /background controller/)
})

test('read-only operations remain nonexclusive and cancellation releases stalled inventory and usage snapshots', async (t) => {
  const { root, source } = await fixture(t)
  let started!: () => void, finish!: () => void
  let ready = new Promise<void>((resolve) => { started = resolve })
  const service = new MigrationService({ roots: source, appVersion: 'test', cliVersion: () => null, assertIdle: async () => {},
    plugins: async () => { started(); return new Promise(() => {}) },
    exportUsage: async (path) => { started(); await new Promise<void>((resolve) => { finish = resolve }); await put(path, 'late snapshot') },
    restoreUsage: async () => {}, progress: () => {}, reloaded: async () => {} })
  const inventory = service.inventory({ categories: ['plugins'], projectIds: [] })
  await ready
  assert.equal(service.status().busy, true); assert.equal(service.status().exclusive, false)
  service.cancel(); await assert.rejects(inventory, /abort/i)
  assert.equal(service.status().busy, false)
  ready = new Promise<void>((resolve) => { started = resolve })
  const exporting = service.export(join(root, 'cancelled.zip'), { categories: ['usage'], projectIds: [] })
  await ready
  assert.equal(service.status().exclusive, true)
  service.cancel(); await assert.rejects(exporting, /abort/i)
  assert.equal(service.status().busy, false)
  await assert.rejects(readFile(join(root, 'cancelled.zip')), /ENOENT/)
  assert.ok((await readdir(source.desktop)).some((name) => name.startsWith('migration-staging-')))
  finish()
  for (let i = 0; i < 100 && (await readdir(source.desktop)).some((name) => name.startsWith('migration-staging-')); i++) await new Promise((resolve) => setTimeout(resolve, 10))
  assert.ok(!(await readdir(source.desktop)).some((name) => name.startsWith('migration-staging-')))
})

test('round trip uses independent CLI and agent roots, strips structured credentials and preserves binary skill assets', async (t) => {
  const { root, source, target } = await fixture(t)
  await put(join(source.copilot, 'settings.json'), '{ // JSONC\n "model": "gpt-test", "defaultPermissionMode":"autopilot", "apiKey":"SECRET", "unknownThing":true, }')
  await put(join(source.copilot, 'config.json'), '{"loggedInUsers":[{"token":"SECRET"}]}')
  await put(join(source.copilot, 'skills/demo/SKILL.md'), '---\nname: demo\n---\nUse refs.')
  await put(join(source.copilot, 'skills/demo/ref.bin'), Buffer.from([0, 255, 3]))
  await put(join(source.agentSkills, 'shared/SKILL.md'), 'shared skill')
  await put(join(source.copilot, 'mcp-config.json'), JSON.stringify({ mcpServers: { demo: { command: 'node', env: { TOKEN: 'SECRET', API_KEY: '${API_KEY}' }, headers: { Authorization: 'SECRET' }, url: 'https://user:SECRET@example.com/mcp?token=SECRET' } } }))
  const info = manifest()
  const files = await collectMigration(source, info, new Set(choices.categories))
  assert.ok(!files.some((file) => file.path === 'copilot/config.json'))
  assert.ok(!files.some((file) => file.data.includes('SECRET')))
  const output = join(root, 'export.zip')
  await writeMigrationArchive(output, info, files)
  const loaded = await readMigrationArchive(output)
  const plan = await planMigrationImport(loaded, target, {}, choices)
  await applyMigrationImport(plan, target)
  assert.deepEqual(await readFile(join(target.copilot, 'skills/demo/ref.bin')), Buffer.from([0, 255, 3]))
  assert.equal(await readFile(join(target.agentSkills, 'shared/SKILL.md'), 'utf8'), 'shared skill')
  assert.deepEqual(jsonObject(await readFile(join(target.copilot, 'settings.json'))), { model: 'gpt-test' })
  const server = jsonObject(await readFile(join(target.copilot, 'mcp-config.json'))).mcpServers as Record<string, { env: unknown }>
  assert.deepEqual(server.demo!.env, { API_KEY: '${API_KEY}' })
  const repeat = await planMigrationImport(loaded, target, {}, choices)
  assert.equal(repeat.writes.length, 0)
})

test('key-level conflicts preserve existing settings and use selected replacements only', async (t) => {
  const { target } = await fixture(t)
  await put(join(target.copilot, 'settings.json'), '{"model":"local","theme":"dark","localOnly":42}')
  const data = archive(fileEntry('copilot/settings.json', 'settings', jsonBytes({ model: 'imported', banner: 'never' })))
  const plan = await planMigrationImport(data, target, {}, choices)
  assert.equal(plan.preview.changes.find((c) => c.id.endsWith('#model'))?.action, 'keep')
  await applyMigrationImport(plan, target)
  assert.deepEqual(jsonObject(await readFile(join(target.copilot, 'settings.json'))), { model: 'local', theme: 'dark', localOnly: 42, banner: 'never' })
  const replace = await planMigrationImport(data, target, {}, { ...choices, replace: ['copilot/settings.json#model'] })
  await applyMigrationImport(replace, target)
  assert.equal(jsonObject(await readFile(join(target.copilot, 'settings.json'))).model, 'imported')
})

test('whole-skill replacement removes stale assets, backs up originals, and preserves unrelated skills', async (t) => {
  const { target } = await fixture(t)
  await put(join(target.copilot, 'skills/demo/SKILL.md'), 'old')
  await put(join(target.copilot, 'skills/demo/stale.txt'), 'stale')
  await put(join(target.copilot, 'skills/unrelated/SKILL.md'), 'keep')
  const data = archive(fileEntry('copilot/skills/demo/SKILL.md', 'skills', Buffer.from('new')), fileEntry('copilot/skills/demo/new.txt', 'skills', Buffer.from('asset')))
  const keep = await planMigrationImport(data, target, {}, choices)
  assert.equal(keep.writes.length, 0)
  const take = await planMigrationImport(data, target, {}, { ...choices, replace: ['copilot/skills/demo'] })
  const result = await applyMigrationImport(take, target)
  assert.ok(result.backup)
  assert.equal(await readFile(join(target.copilot, 'skills/unrelated/SKILL.md'), 'utf8'), 'keep')
  assert.deepEqual((await readdir(join(target.copilot, 'skills/demo'))).sort(), ['SKILL.md', 'new.txt'].sort())
  assert.ok((await readdir(result.backup)).some((name) => name.endsWith('.bak')))
})

test('destination file and directory changes invalidate the reviewed plan', async (t) => {
  const { target } = await fixture(t)
  const data = archive(fileEntry('copilot/skills/demo/SKILL.md', 'skills', Buffer.from('new')))
  const plan = await planMigrationImport(data, target, {}, choices)
  await put(join(target.copilot, 'skills/demo/unseen.txt'), 'external write')
  await assert.rejects(applyMigrationImport(plan, target), /changed/)
  await assert.rejects(readFile(join(target.copilot, 'skills/demo/SKILL.md')), /ENOENT/)
})

test('Windows case differences do not create duplicate asset writes or stale-file deletions', async (t) => {
  const { target } = await fixture(t)
  await put(join(target.copilot, 'skills/demo/SKILL.md'), 'old')
  await put(join(target.copilot, 'skills/demo/ReadMe.txt'), 'old asset')
  const data = archive(fileEntry('copilot/skills/demo/SKILL.md', 'skills', Buffer.from('new')), fileEntry('copilot/skills/demo/README.txt', 'skills', Buffer.from('new asset')))
  const plan = await planMigrationImport(data, target, {}, { ...choices, replace: ['copilot/skills/demo'] })
  assert.equal(plan.writes.length, 2)
  assert.ok(plan.writes.every((item) => item.data !== null))
  await applyMigrationImport(plan, target)
  assert.equal(await readFile(join(target.copilot, 'skills/demo/ReadMe.txt'), 'utf8'), 'new asset')
  assert.equal((await planMigrationImport(data, target, {}, choices)).writes.length, 0)
})

test('cancellation during application rolls back changed and newly added files', async (t) => {
  const { target } = await fixture(t)
  await put(join(target.copilot, 'copilot-instructions.md'), 'original')
  const data = archive(fileEntry('copilot/copilot-instructions.md', 'knowledge', Buffer.from('replacement')), fileEntry('copilot/instructions/new.instructions.md', 'knowledge', Buffer.from('new')))
  const plan = await planMigrationImport(data, target, {}, { ...choices, replace: ['copilot/copilot-instructions.md'] })
  const abort = new AbortController()
  await assert.rejects(applyMigrationImport(plan, target, abort.signal, () => abort.abort()), /abort/i)
  assert.equal(await readFile(join(target.copilot, 'copilot-instructions.md'), 'utf8'), 'original')
  await assert.rejects(readFile(join(target.copilot, 'instructions/new.instructions.md')), /ENOENT/)
  await recoverMigrationImports(target.desktop)
})

test('startup recovery rolls back an interrupted write and retains evidence', async (t) => {
  const { target } = await fixture(t)
  const destination = join(target.copilot, 'copilot-instructions.md')
  const directory = join(target.desktop, 'migration-backups', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')
  await put(destination, 'after')
  await put(join(directory, '0.bak'), 'before')
  await put(join(directory, 'journal.json'), jsonBytes({ version: 1, status: 'pending', roots: [target.copilot], writes: [{ target: destination, before: digest(Buffer.from('before')), after: digest(Buffer.from('after')) }] }))
  await recoverMigrationImports(target.desktop)
  assert.equal(await readFile(destination, 'utf8'), 'before')
  assert.equal(jsonObject(await readFile(join(directory, 'journal.json'))).status, 'rolled-back')
})

test('recovery refuses to overwrite changes made after interruption', async (t) => {
  const { target } = await fixture(t)
  const destination = join(target.copilot, 'copilot-instructions.md')
  const directory = join(target.desktop, 'migration-backups', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb')
  await put(destination, 'third party')
  await put(join(directory, '0.bak'), 'before')
  await put(join(directory, 'journal.json'), jsonBytes({ version: 1, status: 'pending', roots: [target.copilot], writes: [{ target: destination, before: digest(Buffer.from('before')), after: digest(Buffer.from('after')) }] }))
  assert.match((await recoverMigrationImports(target.desktop)).join('\n'), /destination changed/)
  assert.equal(jsonObject(await readFile(join(directory, 'journal.json'))).status, 'needs-attention')
  assert.match((await recoverMigrationImports(target.desktop)).join('\n'), /destination changed/)
  assert.equal(await readFile(destination, 'utf8'), 'third party')
})

test('workspace mapping normalizes IDs, skips unmapped profiles, and does not restore sessions or OS integration', async (t) => {
  const { root, target } = await fixture(t)
  const workspace = join(root, 'destination-repo'); await mkdir(workspace)
  const data = archive(fileEntry('desktop/preferences.json', 'desktop', jsonBytes({ ...DEFAULT_DESKTOP_CONFIG, launchAtLogin: true, globalShortcutEnabled: true, provider: { type: 'openai', model: 'test', baseUrl: 'SECRET' }, profiles: [{ name: 'Work', path: 'D:\\old\\work', permissionPreset: 'full-access', launch: { mode: 'autopilot' }, tabs: [{ title: 'old', lastSessionId: 'old' }] }] })))
  const id = 'aaaaaaaaaaaaaaaa'
  data.manifest.projects = [{ id, name: 'Work', sourcePath: 'D:\\old\\work' }]
  await applyMigrationImport(await planMigrationImport(data, target, { [id]: workspace }, choices), target)
  const config = await readDesktopConfig(join(target.desktop, 'desktop.json'))
  assert.equal(config.profiles[0]?.id, workspaceProfileId(workspace))
  assert.equal(config.profiles[0]?.permissionPreset, 'default')
  assert.equal(config.profiles[0]?.launch.mode, 'interactive')
  assert.deepEqual(config.profiles[0]?.tabs, [])
  assert.equal(config.launchAtLogin, false)
  assert.equal(config.globalShortcutEnabled, false)
  assert.equal(config.provider.baseUrl, '')
})

test('project files require a mapping and executable project hooks require Tools selection', async (t) => {
  const { root, target } = await fixture(t)
  const workspace = join(root, 'repo'); await mkdir(workspace)
  const id = 'aaaaaaaaaaaaaaaa'
  const data = archive(fileEntry(`projects/${id}/AGENTS.md`, 'projects', Buffer.from('guidance')), fileEntry(`projects/${id}/.github/hooks/run.json`, 'projects', jsonBytes({ command: 'danger' })))
  data.manifest.projects = [{ id, name: 'project', sourcePath: 'D:\\old' }]
  assert.equal((await planMigrationImport(data, target, {}, choices)).writes.length, 0)
  const plan = await planMigrationImport(data, target, { [id]: workspace }, { ...choices, categories: ['projects'] })
  assert.equal(plan.writes.length, 1)
  await applyMigrationImport(plan, target)
  assert.equal(await readFile(join(workspace, 'AGENTS.md'), 'utf8'), 'guidance')
})

test('invalid JSONC and dangerous keys fail without changing destination', async (t) => {
  const { target } = await fixture(t)
  assert.throws(() => portableSettings(Buffer.from('{"model":'), []), /Invalid JSON/)
  const data = archive(fileEntry('copilot/settings.json', 'settings', Buffer.from('{"model":"new"}')))
  await put(join(target.copilot, 'settings.json'), '{broken')
  await assert.rejects(planMigrationImport(data, target, {}, choices), /Invalid JSON/)
  assert.equal(await readFile(join(target.copilot, 'settings.json'), 'utf8'), '{broken')
})

test('current nested settings and explicit tool settings are preserved without credential fallback literals', () => {
  const input = jsonBytes({ effortLevel: 'high', beep: false, subagents: { maxConcurrency: 3, unknown: 'omit' },
    statusLine: { type: 'command', command: 'node status.js', env: { API_KEY: '${API_KEY:-secret-fallback}' } } })
  const warnings: string[] = []
  const basic = jsonObject(portableSettings(input, warnings))
  assert.deepEqual(basic.subagents, { maxConcurrency: 3 })
  assert.equal(basic.effortLevel, 'high')
  assert.ok(!('statusLine' in basic))
  const tools = portableSettings(input, warnings, true)
  assert.ok(!tools.includes('secret-fallback'))
  assert.ok(tools.includes('node status.js'))
})

test('known structured tool and skill paths follow an explicit workspace mapping', async (t) => {
  const { root, target } = await fixture(t)
  const old = join(root, 'old'), next = join(root, 'new'); await mkdir(next)
  const data = archive(fileEntry('copilot/mcp-config.json', 'tools', jsonBytes({ mcpServers: { example: { command: join(old, 'server.exe'), cwd: old } } })),
    fileEntry('copilot/settings.json', 'settings', jsonBytes({ skillDirectories: [join(old, 'skills')] })))
  data.manifest.projects = [{ id: 'aaaaaaaaaaaaaaaa', name: 'project', sourcePath: old }]
  const plan = await planMigrationImport(data, target, { aaaaaaaaaaaaaaaa: next }, choices)
  await applyMigrationImport(plan, target)
  const settings = jsonObject(await readFile(join(target.copilot, 'settings.json')))
  assert.deepEqual(settings.skillDirectories, [join(next, 'skills')])
  assert.ok((await readFile(join(target.copilot, 'mcp-config.json'), 'utf8')).includes(JSON.stringify(join(next, 'server.exe'))))
})

test('plugin inventory excludes built-in skills and does not offer scope labels as installation sources', async (t) => {
  const { root, source } = await fixture(t)
  const service = new MigrationService({ roots: source, appVersion: 'test', cliVersion: () => null, assertIdle: async () => {},
    plugins: async () => ({ plugins: [{ kind: 'skill', name: 'builtin-skill', source: 'builtin' }, { kind: 'plugin', name: 'example', source: 'owner/repo', version: '1' }, { kind: 'plugin', name: 'unknown-source', source: 'marketplace' }] }),
    exportUsage: async () => {}, restoreUsage: async () => {}, progress: () => {}, reloaded: async () => {} })
  const path = join(root, 'plugins.zip')
  await service.export(path, { categories: ['plugins'], projectIds: [] })
  const opened = await service.open(path)
  assert.deepEqual(opened.plugins, [{ name: 'example', source: 'owner/repo', version: '1' }, { name: 'unknown-source', source: '', version: '' }])
})

test('unsafe Windows paths, secret-store paths and unsupported history are rejected', async (t) => {
  const { target } = await fixture(t)
  for (const path of ['../outside', '/absolute', 'C:/outside', 'foo\\bar', 'foo/CON.txt', 'foo:stream', 'foo/trailing.', 'foo/a?b']) assert.throws(() => safeRelative(path))
  for (const path of ['copilot/config.json', 'copilot/mcp-secrets/token', 'history/session-store.db']) await assert.rejects(planMigrationImport(archive(fileEntry(path, 'settings', Buffer.from('secret'))), target, {}, choices), /category/)
})

test('source and destination junctions are refused', async (t) => {
  const { root, target } = await fixture(t)
  const outside = join(root, 'outside'); await mkdir(outside)
  await symlink(outside, join(target.copilot, 'skills'), 'junction')
  await assert.rejects(planMigrationImport(archive(fileEntry('copilot/skills/demo/SKILL.md', 'skills', Buffer.from('new'))), target, {}, choices), /junction/)
  assert.deepEqual(await readdir(outside), [])
})

async function rawZip(path: string, entries: { name: string; data: Buffer; mode?: number }[]): Promise<void> {
  const zip = new yazl.ZipFile()
  const completed = pipeline(zip.outputStream, createWriteStream(path))
  for (const entry of entries) zip.addBuffer(entry.data, entry.name, { mode: entry.mode ?? 0o100600 })
  zip.end(); await completed
}
test('ZIP validation rejects case collisions, links, unexpected entries and damaged hashes', async (t) => {
  const { root } = await fixture(t)
  const path = join(root, 'bad.zip'), entry = fileEntry('copilot/copilot-instructions.md', 'knowledge', Buffer.from('expected'))
  const { data: _data, ...metadata } = entry
  const info = { ...manifest(), entries: [metadata] }
  const baseline = { name: 'manifest.json', data: jsonBytes(info) }
  const cases = [
    [{ name: entry.path, data: entry.data }, { name: entry.path.toUpperCase(), data: entry.data }],
    [{ name: entry.path, data: entry.data, mode: 0o120777 }],
    [{ name: entry.path, data: Buffer.from('tampered') }],
    [{ name: entry.path, data: entry.data }, { name: 'unexpected.txt', data: Buffer.from('unlisted') }],
  ]
  for (const entries of cases) { await rawZip(path, [baseline, ...entries]); await assert.rejects(readMigrationArchive(path)) }
  await rawZip(path, [{ name: 'manifest.json', data: jsonBytes({ ...info, version: 2 }) }, { name: entry.path, data: entry.data }])
  await assert.rejects(readMigrationArchive(path), /Unsupported/)
})

test('service binds preview to operation ID, honors writer checks, and keeps usage failure separate', async (t) => {
  const { root, source, target } = await fixture(t)
  await put(join(source.copilot, 'copilot-instructions.md'), 'transfer')
  let idle = true
  const service = (roots: MigrationRoots): MigrationService => new MigrationService({ roots, appVersion: 'test', cliVersion: () => null,
    assertIdle: async () => { if (!idle) throw new Error('writer active') }, plugins: async () => [],
    exportUsage: async (path) => { await put(path, 'usage fixture') }, restoreUsage: async () => { throw new Error('incompatible usage') }, progress: () => {}, reloaded: async () => {},
  })
  const sender = service(source), receiver = service(target), path = join(root, 'transfer.zip')
  await sender.export(path, { categories: ['knowledge', 'usage'], projectIds: [] })
  await receiver.open(path)
  const preview = await receiver.preview({ ...choices, categories: ['knowledge', 'usage'] })
  await assert.rejects(receiver.apply('wrong-id'), /preview/)
  idle = false
  await assert.rejects(receiver.apply(preview.id), /writer/)
  idle = true
  const result = await receiver.apply(preview.id)
  assert.equal(await readFile(join(target.copilot, 'copilot-instructions.md'), 'utf8'), 'transfer')
  assert.ok(result.warnings.some((warning) => warning.includes('usage merge did not complete')))
  await assert.rejects(receiver.apply(preview.id), /preview/)
})

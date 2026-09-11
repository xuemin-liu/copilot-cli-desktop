import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { createWriteStream, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import yazl from 'yazl'
import { DEFAULT_DESKTOP_CONFIG, normalizeDesktopConfig, readDesktopConfig, workspaceProfileId } from './desktop-config.js'
import { applyMigrationImport, planMigrationImport, recoverMigrationReport } from './migration-import.js'
import { collectMigration, digest, fileEntry, jsonBytes, jsonObject, portableSettings, safeRelative } from './migration-inventory.js'
import { readMigrationArchive, writeMigrationArchive, type MigrationArchive } from './migration-archive.js'
import { MigrationService } from './migration-service.js'
import { listMigrationBackups } from './migration-backups.js'
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

function migrationService(roots: MigrationRoots, overrides: Partial<ConstructorParameters<typeof MigrationService>[0]> = {}): MigrationService {
  return new MigrationService({ roots, appVersion: 'test', cliVersion: () => null, assertIdle: async () => {}, plugins: async () => [],
    exportUsage: async (path) => put(path, 'snapshot'), restoreUsage: async () => {}, progress: () => {}, reloaded: async () => {}, ...overrides })
}
function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

test('initial and overlapping backup status requests wait for the latest scan to publish', async (t) => {
  const { target } = await fixture(t)
  const first = deferred<Awaited<ReturnType<typeof listMigrationBackups>>>()
  const second = deferred<Awaited<ReturnType<typeof listMigrationBackups>>>()
  let scans = 0, initialFinished = false
  const service = migrationService(target, { listBackups: () => ++scans === 1 ? first.promise : second.promise })
  const initial = service.ensureBackups().then(() => { initialFinished = true })
  const refreshed = service.refreshBackups()
  first.resolve({ backups: [], warnings: ['stale warning'] })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(initialFinished, false)
  const backup = { id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', path: 'snapshot', status: 'usage-snapshot' as const, bytes: 1, token: 'fresh' }
  second.resolve({ backups: [backup], warnings: ['current warning'] })
  await initial
  assert.deepEqual((await refreshed).backups, [backup])
  assert.deepEqual(service.status().warnings, ['current warning'])
  await service.ensureBackups()
  assert.equal(scans, 2, 'cached status must not rescan')
})

test('backup bookkeeping does not delay the usage merge or turn cancellation into a failed snapshot', async (t) => {
  const { root, target } = await fixture(t)
  const zip = join(root, 'usage.zip')
  await writeMigrationArchive(zip, manifest(), [fileEntry('usage/usage.sqlite', 'usage', Buffer.from('usage'))])
  const scanGate = deferred(), mergeStarted = deferred()
  let snapshotWritten = false
  const service = migrationService(target, {
    exportUsage: async (path) => { await put(path, 'snapshot'); snapshotWritten = true },
    listBackups: async (path) => { if (snapshotWritten) await scanGate.promise; return listMigrationBackups(path) },
    restoreUsage: async () => { mergeStarted.resolve() },
  })
  await service.open(zip)
  const work = service.apply((await service.preview({ ...choices, categories: ['usage'] })).id)
  try {
    await Promise.race([mergeStarted.promise, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('backup scan blocked usage merge')), 3000); timer.unref() })])
    service.cancel()
  } finally { scanGate.resolve() }
  const result = await work
  assert.equal(await readFile(join(result.backup!, 'usage-before.sqlite'), 'utf8'), 'snapshot')
  assert.ok(result.warnings.includes('Usage records merged successfully.'))
  assert.ok(!result.warnings.some((warning) => warning.includes('merge did not complete')))
})

test('usage-inclusive and usage-only imports publish final backup sizes and tokens before returning', async (t) => {
  const { root, target } = await fixture(t)
  const zip = join(root, 'usage.zip')
  await writeMigrationArchive(zip, manifest(), [fileEntry('copilot/copilot-instructions.md', 'knowledge', Buffer.from('new')), fileEntry('usage/usage.sqlite', 'usage', Buffer.from('usage'))])
  for (const categories of [['knowledge', 'usage'], ['usage']] as const) {
    const service = migrationService(target)
    await service.open(zip)
    const result = await service.apply((await service.preview({ ...choices, categories: [...categories] })).id)
    const listed = service.status().backups.find((backup) => backup.path === result.backup)!
    const disk = (await listMigrationBackups(target.desktop)).backups.find((backup) => backup.path === result.backup)!
    assert.equal(listed.bytes, disk.bytes)
    assert.equal(listed.token, disk.token)
    if (categories.length === 1) assert.equal(listed.status, 'usage-snapshot')
    await service.deleteBackup(listed.id, listed.token)
  }
})

test('backup listing is lazy and does not take the operation lock or alter active progress', async (t) => {
  const { target } = await fixture(t)
  const path = join(target.desktop, 'migration-backups', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')
  await mkdir(path, { recursive: true }); await put(join(path, 'usage-before.sqlite'), 'usage')
  let entered!: () => void
  const started = new Promise<void>((resolve) => { entered = resolve })
  const progress: string[] = []
  const service = migrationService(target, { progress: (value) => progress.push(value.phase), plugins: async () => { entered(); return new Promise(() => {}) } })
  assert.deepEqual(service.status().backups, [])
  await service.ensureBackups()
  assert.equal(service.status().backups.length, 1)
  const inventory = service.inventory({ categories: ['plugins'], projectIds: [] })
  await started
  const before = service.status().progress
  const events = [...progress]
  await service.refreshBackups()
  assert.equal(service.status().busy, true)
  assert.deepEqual(service.status().progress, before)
  assert.deepEqual(progress, events)
  service.cancel(); await assert.rejects(inventory, /abort/i)
})

test('dismissing a journal does not prevent apply from automatically recovering another pending journal', async (t) => {
  const { root, target } = await fixture(t)
  const a = join(target.desktop, 'migration-backups', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')
  const b = join(target.desktop, 'migration-backups', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb')
  const destination = join(target.copilot, 'instructions/recovered.md')
  await put(join(a, 'journal.json'), '{invalid journal}')
  await put(destination, 'after'); await put(join(b, '0.bak'), 'before')
  await put(join(b, 'journal.json'), jsonBytes({ version: 1, status: 'pending', roots: [target.copilot], writes: [{ target: destination, before: digest(Buffer.from('before')), after: digest(Buffer.from('after')) }] }))
  const service = migrationService(target)
  const report = await recoverMigrationReport(target.desktop, false, false)
  service.recoveryIssues = report.issues; service.recoveryJournals = report.journals
  const journal = report.journals.find((entry) => entry.path === a)!
  await service.dismissRecovery(journal.id, journal.sha256)
  assert.equal(await readFile(destination, 'utf8'), 'after')
  assert.equal(service.status().recoveryIssues.length, 1)
  const zip = join(root, 'input.zip')
  await writeMigrationArchive(zip, manifest(), [fileEntry('copilot/copilot-instructions.md', 'knowledge', Buffer.from('imported'))])
  await service.open(zip)
  await service.apply((await service.preview(choices)).id)
  assert.equal(await readFile(destination, 'utf8'), 'before')
  assert.deepEqual(service.status().recoveryIssues, [])
  assert.equal(service.status().lastImport?.status, 'completed')
})

test('tool JSON serialization removes comments and shadowed duplicate secrets on both export and import', async (t) => {
  const { source, target } = await fixture(t)
  const samples = ['{ "env": { // "GITHUB_TOKEN": "LEAK_COMMENT"\n "API_KEY":"${API_KEY}" }}', '{"env":{"GITHUB_TOKEN":"LEAK_DUPLICATE"},"env":{"API_KEY":"${API_KEY}"}}']
  for (const [index, text] of samples.entries()) await put(join(source.copilot, `hooks/${index}.jsonc`), text)
  const files = await collectMigration(source, manifest(), new Set(['tools']))
  assert.ok(files.every((file) => !file.data.includes('LEAK_')))
  const raw = archive(...samples.map((text, index) => fileEntry(`copilot/hooks/${index}.jsonc`, 'tools', Buffer.from(text))))
  await applyMigrationImport(await planMigrationImport(raw, target, {}, choices), target)
  for (let index = 0; index < samples.length; index++) assert.ok(!(await readFile(join(target.copilot, `hooks/${index}.jsonc`), 'utf8')).includes('LEAK_'))
})

test('absent optional paths are quiet while unavailable selected workspaces are reported', async (t) => {
  const { source, root } = await fixture(t)
  const repo = join(root, 'repo'); await put(join(repo, 'AGENTS.md'), 'project')
  await put(join(source.copilot, 'skills/example/SKILL.md'), 'skill')
  const info = manifest(); info.projects = [{ id: 'aaaaaaaaaaaaaaaa', name: 'repo', sourcePath: repo }]
  await collectMigration(source, info, new Set(choices.categories))
  assert.deepEqual(info.warnings, [])
  info.projects.push({ id: 'bbbbbbbbbbbbbbbb', name: 'missing', sourcePath: join(root, 'disconnected') })
  await collectMigration(source, info, new Set(choices.categories))
  assert.equal(info.warnings.length, 1)
  assert.match(info.warnings[0]!, /disconnected/)
})

test('post-commit reload failure is a success warning and preconditions preserve the last import outcome', async (t) => {
  const { root, target } = await fixture(t)
  const zip = join(root, 'input.zip'), destination = join(target.copilot, 'copilot-instructions.md')
  await writeMigrationArchive(zip, manifest(), [fileEntry('copilot/copilot-instructions.md', 'knowledge', Buffer.from('committed'))])
  let reloads = 0, idle = true
  const service = migrationService(target, { assertIdle: async () => { if (!idle) throw new Error('session open') }, reloaded: async () => { if (++reloads === 2) throw new Error('EBUSY refresh') } })
  await assert.rejects(service.apply('stale'), /preview/)
  assert.equal(service.status().lastImport, null)
  await service.open(zip)
  let preview = await service.preview(choices)
  idle = false
  await assert.rejects(service.apply(preview.id), /session open/)
  assert.equal(service.status().lastImport, null)
  idle = true
  const result = await service.apply(preview.id)
  assert.equal(await readFile(destination, 'utf8'), 'committed')
  assert.equal(service.status().lastImport?.status, 'completed')
  assert.ok(result.warnings.some((warning) => warning.includes('EBUSY refresh')))
  const previous = service.status().lastImport
  preview = await service.preview(choices); idle = false
  await assert.rejects(service.apply(preview.id), /session open/)
  assert.deepEqual(service.status().lastImport, previous)
})

test('cancellation outcome uses the transaction rollback result even when the following reload fails', async (t) => {
  const { root, target } = await fixture(t)
  const zip = join(root, 'input.zip')
  await writeMigrationArchive(zip, manifest(), ['a', 'b'].map((name) => fileEntry(`copilot/instructions/${name}.md`, 'knowledge', Buffer.from(name))))
  let reloads = 0
  const service = migrationService(target, { progress: (value) => { if (value.completed === 1) service.cancel() }, reloaded: async () => { if (++reloads === 2) throw new Error('reload unavailable') } })
  await service.open(zip)
  await assert.rejects(service.apply((await service.preview(choices)).id), /abort/i)
  assert.equal(service.status().lastImport?.status, 'cancelled')
  assert.match(service.status().lastImport!.message, /rolled back/)
  assert.ok(service.status().warnings.some((warning) => warning.includes('reload unavailable')))
  await assert.rejects(readFile(join(target.copilot, 'instructions/a.md')), /ENOENT/)
})

test('dismissal is nonexclusive, leaves other pending targets untouched, and exposes preserved backups for explicit deletion', async (t) => {
  const { target } = await fixture(t)
  const id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', directory = join(target.desktop, 'migration-backups', id)
  const other = join(target.desktop, 'migration-backups', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb')
  const destination = join(target.copilot, 'copilot-instructions.md')
  await put(destination, 'after')
  await put(join(directory, 'journal.json'), '{unreadable JSON}')
  await put(join(directory, '0.bak'), 'PRIVATE_BACKUP')
  await put(join(other, '0.bak'), 'before')
  await put(join(other, 'journal.json'), jsonBytes({ version: 1, status: 'pending', roots: [target.copilot], writes: [{ target: destination, before: digest(Buffer.from('before')), after: digest(Buffer.from('after')) }] }))
  const report = await recoverMigrationReport(target.desktop, false, false)
  const service = migrationService(target, { assertIdle: async () => { throw new Error('active session') }, reloaded: async () => { throw new Error('must not reload') } })
  service.recoveryIssues = report.issues; service.recoveryJournals = report.journals
  const journal = report.journals.find((entry) => entry.id === id)!
  await service.dismissRecovery(id, journal.sha256)
  assert.equal(await readFile(destination, 'utf8'), 'after')
  assert.equal(service.status().exclusive, false)
  const backup = service.status().backups.find((entry) => entry.id === id)!
  assert.equal(backup.status, 'dismissed')
  assert.equal(await readFile(join(directory, '0.bak'), 'utf8'), 'PRIVATE_BACKUP')
  assert.ok(!service.status().backups.some((entry) => entry.id.startsWith('bbbb')))
  await assert.rejects(service.deleteBackup(id, 'stale'), /review the backup list/)
  await put(join(directory, '0.bak'), 'PRIVATE_BACKUP changed')
  await assert.rejects(service.deleteBackup(id, backup.token), /Backup changed/)
  await service.refreshBackups()
  await service.deleteBackup(id, service.status().backups.find((entry) => entry.id === id)!.token)
  await assert.rejects(readdir(directory), /ENOENT/)
  assert.equal(await readFile(destination, 'utf8'), 'after')
  assert.ok((await readdir(other)).includes('0.bak'))
})

test('retained-backup deletion waits for a cancelled usage snapshot that is still writing', async (t) => {
  const { root, target } = await fixture(t)
  const zip = join(root, 'usage.zip')
  await writeMigrationArchive(zip, manifest(), [fileEntry('copilot/copilot-instructions.md', 'knowledge', Buffer.from('committed')), fileEntry('usage/usage.sqlite', 'usage', Buffer.from('usage'))])
  let entered!: () => void, finish!: () => void, written!: () => void
  const began = new Promise<void>((resolve) => { entered = resolve })
  const gate = new Promise<void>((resolve) => { finish = resolve })
  const done = new Promise<void>((resolve) => { written = resolve })
  const service = migrationService(target, { exportUsage: async (path) => { entered(); await gate; await put(path, 'late usage snapshot'); written() } })
  await service.open(zip)
  const work = service.apply((await service.preview({ ...choices, categories: ['knowledge', 'usage'] })).id)
  await began; service.cancel(); await work
  await service.refreshBackups()
  let backup = service.status().backups[0]!
  await assert.rejects(service.deleteBackup(backup.id, backup.token), /Wait for the usage snapshot/)
  finish(); await done; await new Promise<void>((resolve) => setImmediate(resolve))
  await service.refreshBackups(); backup = service.status().backups[0]!
  await service.deleteBackup(backup.id, backup.token)
  assert.equal(await readFile(join(target.copilot, 'copilot-instructions.md'), 'utf8'), 'committed')
})

test('partially unreadable project and personal trees publish no partial replacement groups', async (t) => {
  const { root, source, target } = await fixture(t)
  const repo = join(root, 'repo'), destination = join(root, 'mapped')
  await mkdir(destination)
  const paths = [join(repo, '.github/skills'), join(source.copilot, 'skills'), join(source.agentSkills), join(source.copilot, 'extensions')]
  for (const path of paths) {
    await put(join(path, 'deploy/SKILL.md'), 'readable')
    await put(join(path, 'deploy/scripts/run.cmd'), 'hidden')
    if (!path.endsWith('extensions')) for (const sibling of ['alpha', 'gamma']) await put(join(path, `${sibling}/SKILL.md`), sibling)
  }
  await put(join(source.copilot, 'copilot-instructions.md'), 'readable guidance')
  const info = manifest(); info.projects = [{ id: 'aaaaaaaaaaaaaaaa', name: 'repo', sourcePath: repo }]
  const files = await collectMigration(source, info, new Set(choices.categories), undefined, async (path) => {
    if (path.endsWith('scripts')) throw Object.assign(new Error('Denied'), { code: 'EACCES' })
    return readdir(path, { withFileTypes: true })
  })
  assert.ok(!files.some((file) => file.path.includes('deploy')))
  assert.equal(files.filter((file) => file.path.endsWith('alpha/SKILL.md')).length, 3)
  assert.equal(files.filter((file) => file.path.endsWith('gamma/SKILL.md')).length, 3)
  assert.ok(files.some((file) => file.path.endsWith('copilot-instructions.md')))
  for (const path of paths) assert.ok(info.warnings.some((warning) => warning.includes(path) && warning.includes('entire')))
  await put(join(destination, '.github/skills/deploy/scripts/run.cmd'), 'keep destination')
  const loaded = { manifest: info, files }
  const plan = await planMigrationImport(loaded, target, { aaaaaaaaaaaaaaaa: destination }, { ...choices, replace: ['projects/aaaaaaaaaaaaaaaa/.github/skills/deploy'] })
  await applyMigrationImport(plan, target)
  assert.equal(await readFile(join(destination, '.github/skills/deploy/scripts/run.cmd'), 'utf8'), 'keep destination')
})

test('parseable hook and extension JSON strips secrets and maps commands without applying the settings allowlist', async (t) => {
  const { root, source, target } = await fixture(t)
  const old = join(root, 'old'), mapped = join(root, 'mapped'); await mkdir(mapped)
  const payload = { hooks: { preToolUse: [{ command: join(old, 'tools/check.cmd'), env: { GITHUB_TOKEN: 'literal-secret', API_KEY: '${API_KEY}' } }] }, 'api-key': 'literal-secret', arbitrary: 42 }
  for (const path of ['hooks/hooks.json', 'extensions/vendor/settings.jsonc']) await put(join(source.copilot, path), jsonBytes(payload))
  await put(join(source.copilot, 'extensions/vendor/list.json'), jsonBytes([payload]))
  await put(join(source.copilot, 'hooks/broken.json'), '{not parseable}')
  const info = manifest(); info.projects = [{ id: 'aaaaaaaaaaaaaaaa', sourcePath: old, name: 'repo' }]
  const files = await collectMigration(source, info, new Set(['tools']))
  assert.ok(!files.some((file) => file.data.includes('literal-secret')))
  const plan = await planMigrationImport({ manifest: info, files }, target, { aaaaaaaaaaaaaaaa: mapped }, choices)
  assert.ok(plan.preview.warnings.some((warning) => warning.includes('Required tool command:') && warning.includes('check.cmd')))
  assert.ok(plan.preview.warnings.some((warning) => warning.includes('Unparsed tool asset')))
  await applyMigrationImport(plan, target)
  const hook = JSON.parse(await readFile(join(target.copilot, 'hooks/hooks.json'), 'utf8'))
  assert.equal(hook.arbitrary, 42)
  assert.equal(hook.hooks.preToolUse[0].command, join(mapped, 'tools/check.cmd'))
  assert.deepEqual(hook.hooks.preToolUse[0].env, { API_KEY: '${API_KEY}' })
  assert.equal(await readFile(join(target.copilot, 'hooks/broken.json'), 'utf8'), '{not parseable}')
  assert.deepEqual(JSON.parse(await readFile(join(target.copilot, 'extensions/vendor/list.json'), 'utf8')), [hook])
})

test('failed rollback preserves the original failure, surfaces recovery immediately, and permits inspected dismissal', async (t) => {
  const { root, target } = await fixture(t)
  const destination = join(target.copilot, 'copilot-instructions.md'), zip = join(root, 'input.zip')
  await put(destination, 'before')
  await writeMigrationArchive(zip, manifest(), [fileEntry('copilot/copilot-instructions.md', 'knowledge', Buffer.from('after'))])
  let reloads = 0, fail = true
  const service = migrationService(target, { reloaded: async () => { reloads++ }, progress: (progress) => {
    if (fail && progress.completed === 1) { writeFileSync(destination, 'third party'); throw new Error('original import failure') }
  } })
  await service.open(zip)
  const plan = await service.preview({ ...choices, replace: ['copilot/copilot-instructions.md'] })
  await assert.rejects(service.apply(plan.id), (error: unknown) => {
    assert.match(String(error), /original import failure.*Rollback needs attention/)
    assert.match(String((error as Error).cause), /original import failure/)
    return true
  })
  assert.equal(reloads, 2)
  assert.equal(service.status().lastImport?.status, 'failed')
  const journal = service.status().recoveryJournals[0]!
  assert.equal(jsonObject(await readFile(join(journal.path, 'journal.json'))).status, 'needs-attention')
  assert.equal(service.status().recoveryIssues.length, 1)
  fail = false
  const retryPlan = await service.preview(choices)
  await assert.rejects(service.apply(retryPlan.id), /Resolve migration recovery/)
  await assert.rejects(service.apply(retryPlan.id), /Resolve migration recovery/)
  await assert.rejects(service.dismissRecovery(journal.id, '0'.repeat(64)), /Review the recovery journal/)
  const reviewedJournal = await readFile(join(journal.path, 'journal.json'))
  await put(join(journal.path, 'journal.json'), Buffer.concat([reviewedJournal, Buffer.from('\n')]))
  await assert.rejects(service.dismissRecovery(journal.id, journal.sha256), /Recovery journal changed/)
  await put(join(journal.path, 'journal.json'), reviewedJournal)
  await service.dismissRecovery(journal.id, journal.sha256)
  assert.deepEqual(service.status().recoveryIssues, [])
  assert.equal(await readFile(destination, 'utf8'), 'third party')
  assert.equal(await readFile(join(journal.path, '0.bak'), 'utf8'), 'before')
  assert.ok((await readdir(journal.path)).some((name) => name.startsWith('journal.dismissed-')))
  const fresh = await service.preview(choices)
  await service.apply(fresh.id)
})

test('service retries real needs-attention recovery and reloads restored desktop preferences', async (t) => {
  const { target } = await fixture(t)
  const destination = join(target.desktop, 'desktop.json'), directory = join(target.desktop, 'migration-backups', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')
  const before = jsonBytes({ notifications: false }), after = jsonBytes({ notifications: true })
  await put(destination, after); await put(join(directory, '0.bak'), before)
  await put(join(directory, 'journal.json'), jsonBytes({ version: 1, status: 'needs-attention', roots: [target.desktop], writes: [{ target: destination, before: digest(before), after: digest(after) }] }))
  let notifications = true
  const service = migrationService(target, { reloaded: async () => { notifications = (await readDesktopConfig(destination)).notifications } })
  const status = await service.recover()
  assert.deepEqual(status.recoveryIssues, [])
  assert.equal(notifications, false)
  assert.equal(jsonObject(await readFile(join(directory, 'journal.json'))).status, 'rolled-back')
})

test('apply reloads recovery changes both before a blocked import and before stale-preview refusal', async (t) => {
  const { root, target } = await fixture(t)
  const destination = join(target.desktop, 'desktop.json'), zip = join(root, 'input.zip')
  const before = jsonBytes({ notifications: false }), after = jsonBytes({ notifications: true })
  await writeMigrationArchive(zip, manifest(), [fileEntry('desktop/preferences.json', 'desktop', before)])
  for (const blocked of [false, true]) {
    await put(destination, after)
    let notifications = true
    const service = migrationService(target, { reloaded: async () => { notifications = (await readDesktopConfig(destination)).notifications } })
    await service.open(zip)
    const plan = await service.preview({ ...choices, replace: ['desktop/preferences.json#notifications'] })
    const directory = join(target.desktop, 'migration-backups', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')
    await put(join(directory, '0.bak'), before)
    await put(join(directory, 'journal.json'), jsonBytes({ version: 1, status: 'pending', roots: [target.desktop], writes: [{ target: destination, before: digest(before), after: digest(after) }] }))
    if (blocked) await put(join(target.desktop, 'migration-backups', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'journal.json'), '{bad journal}')
    await assert.rejects(service.apply(plan.id), blocked ? /Resolve migration recovery/ : /Destination changed/)
    assert.equal(notifications, false)
  }
})

test('cancelled file imports and committed imports with skipped usage retain their outcome in service status', async (t) => {
  const { root, target } = await fixture(t)
  const zip = join(root, 'input.zip'), destination = join(target.copilot, 'copilot-instructions.md')
  await put(destination, 'before')
  await writeMigrationArchive(zip, manifest(), [fileEntry('copilot/copilot-instructions.md', 'knowledge', Buffer.from('after')), fileEntry('copilot/instructions/second.md', 'knowledge', Buffer.from('second')), fileEntry('usage/usage.sqlite', 'usage', Buffer.from('usage'))])
  for (const afterCommit of [false, true]) {
    let reloads = 0
    const service = migrationService(target, { progress: (value) => { if (!afterCommit && value.completed === 1) service.cancel() },
      reloaded: async () => { if (++reloads === 2 && afterCommit) service.cancel() }, restoreUsage: async () => { throw new Error('must not merge cancelled usage') } })
    await service.open(zip)
    const plan = await service.preview({ ...choices, categories: ['knowledge', 'usage'], replace: ['copilot/copilot-instructions.md'] })
    if (!afterCommit) {
      await assert.rejects(service.apply(plan.id), /abort/i)
      assert.equal(await readFile(destination, 'utf8'), 'before')
      assert.equal(service.status().lastImport?.status, 'cancelled')
      assert.match(service.status().lastImport!.message, /rolled back/)
    } else {
      await service.apply(plan.id)
      assert.equal(await readFile(destination, 'utf8'), 'after')
      assert.equal(service.status().lastImport?.status, 'completed')
      assert.ok(service.status().lastImport?.result?.warnings.some((warning) => warning.includes('usage merge did not complete')))
    }
    assert.equal(service.status().busy, false)
  }
})

test('provider replacements retain the destination endpoint and unselected fields', async (t) => {
  const { target } = await fixture(t)
  await put(join(target.desktop, 'desktop.json'), jsonBytes({ provider: { type: 'openai', baseUrl: 'https://local.test/v1', model: 'old', offline: true } }))
  const data = archive(fileEntry('desktop/preferences.json', 'desktop', jsonBytes({ provider: { model: 'new', baseUrl: 'https://imported.test/SECRET' } })))
  const plan = await planMigrationImport(data, target, {}, { ...choices, replace: ['desktop/preferences.json#provider.model'] })
  assert.deepEqual(plan.preview.changes.map((c) => c.id), ['desktop/preferences.json#provider.model'])
  await applyMigrationImport(plan, target)
  assert.deepEqual((await readDesktopConfig(join(target.desktop, 'desktop.json'))).provider, { type: 'openai', baseUrl: 'https://local.test/v1', model: 'new', offline: true })
})

test('opaque assets retain bytes while parseable tool assets retain values', async (t) => {
  const { source, target } = await fixture(t)
  const assets = { 'skills/demo/settings.json': '{"arbitrary":true}', 'extensions/demo/settings.json': '[1,2]', 'extensions/demo/scalar.json': 'false', 'hooks/settings.json': '{not json}', 'skills/demo/ref.json': '{"TOKEN":"private asset"}' }
  for (const [path, bytes] of Object.entries(assets)) await put(join(source.copilot, path), bytes)
  await put(join(source.copilot, 'settings.json'), '{"model":"allowed","arbitrary":true}')
  const files = await collectMigration(source, manifest(), new Set(choices.categories))
  await applyMigrationImport(await planMigrationImport(archive(...files), target, {}, choices), target)
  for (const [path, bytes] of Object.entries(assets)) {
    const imported = await readFile(join(target.copilot, path), 'utf8')
    if (path.startsWith('extensions/')) assert.deepEqual(JSON.parse(imported), JSON.parse(bytes))
    else assert.equal(imported, bytes)
  }
  assert.deepEqual(jsonObject(await readFile(join(target.copilot, 'settings.json'))), { model: 'allowed' })
})

test('all credential-vault key families are removed from tool definitions but references survive', async (t) => {
  const { source, target } = await fixture(t)
  const keys = [...CREDENTIAL_NAMES, 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'api-key', 'api.key', 'x-api-key', 'api key', 'PRIVATE_KEY', 'ACCESS_KEY', 'SIGNING_KEY', 'AUTH', 'AUTHORIZATION', 'PASSWORD', 'CLIENT_SECRET']
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
  assert.match((await recoverMigrationReport(target.desktop)).issues.join(), /needs attention/)
  await put(destination, 'after')
  await put(join(directory, 'journal.json'), jsonBytes({ version: 1, status: 'pending', roots: [target.copilot], writes: [{ target: destination, before: digest(Buffer.from('before')), after: digest(Buffer.from('after')) }] }))
  assert.match((await recoverMigrationReport(target.desktop)).issues.join(), /missing or damaged/)
  await put(join(directory, '0.bak'), 'before')
  assert.equal((await recoverMigrationReport(target.desktop)).issues.length, 1)
  assert.deepEqual((await recoverMigrationReport(target.desktop, true)).issues, [])
  assert.equal(await readFile(destination, 'utf8'), 'before')
  const redirected = join(root, 'redirected'), empty = join(root, 'empty')
  await mkdir(empty); await symlink(empty, redirected, 'junction')
  assert.deepEqual((await recoverMigrationReport(redirected)).issues, [])
})

test('writer checks use authenticated daemon state and ignore stale process identities', async () => {
  const state = { pid: process.pid } as DaemonState
  let queried = false
  await assertMigrationWritersStopped({ readState: async () => null, isAlive: async () => { queried = true; return true }, processAlive: () => false })
  assert.equal(queried, false)
  await assertMigrationWritersStopped({ readState: async () => state, isAlive: async (candidate) => { assert.equal(candidate, state); return false }, processAlive: () => false })
  await assert.rejects(assertMigrationWritersStopped({ readState: async () => state, isAlive: async () => true, processAlive: () => false }), /background controller/)
  await assert.rejects(assertMigrationWritersStopped({ readState: async () => state, isAlive: async () => false, processAlive: () => true }), /could not be verified/)
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
  await recoverMigrationReport(target.desktop)
})

test('startup recovery rolls back an interrupted write and retains evidence', async (t) => {
  const { target } = await fixture(t)
  const destination = join(target.copilot, 'copilot-instructions.md')
  const directory = join(target.desktop, 'migration-backups', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')
  await put(destination, 'after')
  await put(join(directory, '0.bak'), 'before')
  await put(join(directory, 'journal.json'), jsonBytes({ version: 1, status: 'pending', roots: [target.copilot], writes: [{ target: destination, before: digest(Buffer.from('before')), after: digest(Buffer.from('after')) }] }))
  await recoverMigrationReport(target.desktop)
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
  assert.match((await recoverMigrationReport(target.desktop)).issues.join('\n'), /destination changed/)
  assert.equal(jsonObject(await readFile(join(directory, 'journal.json'))).status, 'needs-attention')
  assert.match((await recoverMigrationReport(target.desktop)).issues.join('\n'), /destination changed/)
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

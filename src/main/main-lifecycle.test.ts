import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'
import { build } from 'esbuild'
import { createWorkspaceProfile, DEFAULT_DESKTOP_CONFIG, type DesktopConfig } from './desktop-config.js'
import { EMPTY_COPILOT_CAPABILITIES, type CopilotCapabilities } from './copilot-command.js'
import type { DesktopState, WorkspaceProfile } from './types.js'
import { MigrationService } from './migration-service.js'
import { readMigrationArchive, writeMigrationArchive } from './migration-archive.js'
import { fileEntry } from './migration-inventory.js'
import { MigrationImportFailure } from './migration-import.js'

const SOURCE = '11111111-1111-4111-8111-111111111111'
const FORK = '22222222-2222-4222-8222-222222222222'
interface Harness {
  configureMigration(busy: boolean, exclusive: boolean): void
  configureMigrationExport(service: MigrationService, path: string, senderDestroyed?: boolean): void
  blockSpawnPlan(work: Promise<void>): void
  setNextSpawn(work: () => Promise<void>): void
  flushConfig(): Promise<void>
  checkMigrationIdle(): void
  configure(config: DesktopConfig, capabilities: CopilotCapabilities): void
  createMain(): Promise<DesktopState>
  createSide(profile: WorkspaceProfile, parentId: string): Promise<DesktopState>
  restore(): Promise<void>
  beginQuit(): boolean
  configureUsageStop(stop: () => Promise<void>): void
  configureUpdate(stop: () => Promise<void>, install: () => void): void
  configureUsageUnavailable(phase: 'pause' | 'flush'): void
  updateError(): void
  updateBusy(): boolean
  configureClosePrompt(): void
  closePromptDismissed(): boolean
  promptClose(window: { isDestroyed(): boolean }, result: Promise<{ response: number }>): Promise<void>
  dismissClosePrompt(): void
  quitPendingOnPrompt(): boolean
  configureBlockedConfig(work: Promise<void>): void
  configureMaintenance(): void
  maintenanceCalls: string[]
  maintain(operation: 'install' | 'update'): Promise<void>
  maintenanceStatus(): string
  requestSettings(name: string, ...args: unknown[]): Promise<unknown>
  request(name: string, ...args: unknown[]): Promise<DesktopState>
  cleanup(): Promise<void>
  spawns: { args: string[]; cwd: string; env: NodeJS.ProcessEnv; stopped: boolean; written: string[]; resized: number[][]; emitData(data: string): void }[]
}

/** Exercise the unchanged main.ts lifecycle functions and registered IPC
 * handlers with real launch planning and PtySession. Only Electron's OS shell
 * and the native PTY boundary are replaced. Test-only exports are appended to
 * a disposable bundle, never exposed in the shipped application.
 */
async function fixture(action: (harness: Harness, directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'desktop-lifecycle-unit-'))
  const previousCopilotHome = process.env.COPILOT_HOME
  process.env.COPILOT_HOME = directory
  let harness: Harness | undefined
  try {
    const mainPath = fileURLToPath(new URL('./main.js', import.meta.url))
    const mocks: Record<string, string> = {
      electron: `
        import { EventEmitter } from 'node:events';
        export const app = Object.assign(new EventEmitter(), { requestSingleInstanceLock: () => false, quit() {}, getPath: () => ${JSON.stringify(directory)}, getAppPath: () => ${JSON.stringify(directory)} });
        const handlers = new Map();
        export const ipcMain = { handle: (name, handler) => handlers.set(name, handler), invoke: (name, ...args) => handlers.get(name)(...args) };
        export const Menu = { getApplicationMenu: () => null };
        export const BrowserWindow = class {};
        export const clipboard = {}, dialog = {}, globalShortcut = {}, Notification = {}, safeStorage = {}, shell = {}, Tray = {};
      `,
      'electron-updater': 'export default { autoUpdater: null };',
      // Migration is exercised through its own integration tests. Keep new archive
      // dependencies out of this temporary, dependency-free lifecycle bundle.
      './migration-service.js': 'export class MigrationService {}',
      './migration-import.js': 'export async function recoverMigrationReport() { return { issues: [], journals: [] } }',
      './migration-writers.js': 'export async function assertMigrationWritersStopped() {}',
      './copilot-maintenance.js': `
        export const maintenanceCalls = [];
        export const DEFAULT_COPILOT_MAINTENANCE_STATE = { status: 'idle', operation: null, message: '' };
        export async function installCopilotCli() { maintenanceCalls.push('install'); return ''; }
        export async function updateCopilotCli() { maintenanceCalls.push('update'); return ''; }
      `,
      './node-pty-backend.js': `
        export const spawns = [];
        let nextSpawn;
        export function setNextSpawn(work) { nextSpawn = work; }
        export async function spawnNodePty(file, args, options) {
          const work = nextSpawn; nextSpawn = null; if (work) await work();
          const exits = new Set();
          const dataListeners = new Set();
          const record = { args, cwd: options.cwd, env: options.env, stopped: false, written: [], resized: [], emitData(data) { for (const fn of dataListeners) fn(data); } };
          spawns.push(record);
          return { pid: undefined, onData(fn) { dataListeners.add(fn); }, onExit(fn) { exits.add(fn); }, write(data) { record.written.push(data); }, resize(cols, rows) { record.resized.push([cols, rows]); },
            kill() { record.stopped = true; for (const fn of exits) fn({ exitCode: 0 }); } };
        }
      `,
      './resolve-copilot.js': `
        export async function resolveCopilotBinary() {
          return { kind: 'direct', command: 'inert-pty', prefixArgs: [], resolvedPath: null, version: '1.0.82', error: null, pathAdditions: ['C:/Program Files/nodejs'] };
        }
        export function withCopilotPathAdditions(environment, additions = []) {
          const key = Object.keys(environment).find((name) => name.toLowerCase() === 'path') || 'Path';
          return { ...environment, [key]: [...additions, environment[key]].filter(Boolean).join(';') };
        }
        export function windowsSystemDirectory() { return 'C:/Windows/System32'; }
        export function windowsSystemExecutable(name) { return 'C:/Windows/System32/' + name; }
        export async function findWindowsExecutable() { return null; }
      `,
    }
    const source = await readFile(mainPath, 'utf8')
    const bundle = await build({
      stdin: { contents: source + `
        import { spawns, setNextSpawn } from './node-pty-backend.js';
        import { maintenanceCalls } from './copilot-maintenance.js';
        const diagnosticWrites = [];
        let settingsSenderDestroyed = false;
        const originalWriteAppLog = writeAppLog;
        writeAppLog = (...args) => { const work = originalWriteAppLog(...args); diagnosticWrites.push(work); return work; };
        export const lifecycleTest = {
          configureMigration(busy, exclusive) { migrationService = { busy, exclusive }; },
          configureMigrationExport(service, path, senderDestroyed = false) { migrationService = service; settingsSenderDestroyed = senderDestroyed; dialog.showSaveDialog = async () => ({ canceled: false, filePath: path }); dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }); shell.showItemInFolder = () => {}; },
          blockSpawnPlan(work) { const original = buildSessionSpawnPlan; buildSessionSpawnPlan = async (...args) => { await work; return original(...args); }; },
          checkMigrationIdle,
          spawns,
          setNextSpawn,
          flushConfig: () => configWriteQueue,
          maintenanceCalls,
          configure(config, capabilities) { desktopConfig = config; copilotCapabilities = capabilities;
            state.resolution = { kind: 'direct', command: 'inert-pty', prefixArgs: [], resolvedPath: null, version: '1.0.82', error: null, pathAdditions: ['C:/Program Files/nodejs'] }; syncWorkspaceState(); },
          createMain: () => createSessionTab(),
          createSide: (profile, parentId) => createSessionTab(profile, 'auto-resume', '${FORK}', [], null, 'Side', { sideChat: true, sideParentTabId: parentId }),
          restore: restoreTabsForActiveProfile,
          beginQuit() { let prevented = false; app.emit('before-quit', { preventDefault() { prevented = true; } }); return prevented; },
          configureUsageStop(stop) { usageService = { stop, abort: async () => {} }; },
          configureBlockedConfig(work) { configWriteQueue = work; },
          configureUpdate(flush, install) { usageService = { flush, stop: flush, abort: async () => {}, pauseCollection() {}, resumeCollection() {}, noteSourceChanged() {} }; updateController = { snapshot: { canInstall: true }, install, installationDidNotQuit() {} }; },
          configureUsageUnavailable(phase) {
            const error = new UsageServiceUnavailableError('Usage worker repeatedly failed');
            if (phase === 'pause') usageService.pauseCollection = () => { throw error; };
            else usageService.flush = async () => { throw error; };
          },
          configureClosePrompt() { closePromptWindow = { isDestroyed: () => false }; closePromptAbort = new AbortController(); },
          closePromptDismissed: () => closePromptWindow === null,
          promptClose(window, result) { dialog.showMessageBox = () => result; return promptForWindowClose(window); },
          dismissClosePrompt: dismissClosePromptForUpdate,
          quitPendingOnPrompt: () => quitAfterClosePrompt,
          updateError: recoverUpdateAttempt,
          updateBusy: () => installInProgress,
          configureMaintenance() {
            usageService = { flush: async () => { throw new Error('usage unavailable'); }, collect: async () => { throw new Error('backup disk full'); } };
            state.resolution = { kind: 'direct', command: 'inert', prefixArgs: [], resolvedPath: null, version: '1.0.82', error: null };
            retryResolution = async () => { maintenanceCalls.push('retry-resolution'); return snapshot(); };
          },
          maintain: maintainCopilotCli,
          maintenanceStatus: () => copilotMaintenance.status,
          requestSettings: (name, ...args) => ipcMain.invoke(name, { senderFrame: { url: settingsUrl() }, sender: { isDestroyed: () => settingsSenderDestroyed } }, ...args),
          request: (name, ...args) => ipcMain.invoke(name, { senderFrame: { url: shellUrl() } }, ...args),
          async cleanup() { clearTimeout(updateQuitTimer); await stopAllSessions(); await configWriteQueue; await Promise.allSettled(diagnosticWrites); },
        };
      `, resolveDir: dirname(mainPath), loader: 'js' },
      bundle: true, platform: 'node', format: 'esm', packages: 'external', write: false,
      plugins: [{ name: 'inert-os-boundaries', setup(builder) {
        builder.onResolve({ filter: /^(electron|electron-updater|\.\/(node-pty-backend|resolve-copilot|copilot-maintenance|migration-service|migration-import|migration-writers)\.js)$/ }, (args) => ({ path: args.path, namespace: 'test-boundary' }))
        builder.onLoad({ filter: /.*/, namespace: 'test-boundary' }, (args) => ({ contents: mocks[args.path]!, loader: 'js' }))
      } }],
    })
    const bundlePath = join(directory, 'main-harness.mjs')
    await writeFile(bundlePath, bundle.outputFiles[0]!.contents)
    harness = (await import(pathToFileURL(bundlePath).href)).lifecycleTest as Harness
    await action(harness, directory)
  } finally {
    await harness?.cleanup()
    if (previousCopilotHome === undefined) delete process.env.COPILOT_HOME
    else process.env.COPILOT_HOME = previousCopilotHome
    await rm(directory, { recursive: true, force: true })
  }
}

test('workspace session creation targets an inactive profile without restoring its saved tabs', async () => fixture(async (harness, directory) => {
  const first = createWorkspaceProfile(directory)
  const targetPath = join(directory, 'second'); await mkdir(targetPath)
  const second = createWorkspaceProfile(targetPath, 'read-only')
  second.defaultResumeMode = 'continue'
  harness.configure({ ...structuredClone(DEFAULT_DESKTOP_CONFIG), profiles: [first, second], activeProfileId: first.id }, { ...EMPTY_COPILOT_CAPABILITIES, sessionIdentity: true, toolAllowlist: true })
  const original = await harness.createMain()
  second.tabs = [{ title: 'Saved session', lastSessionId: SOURCE }]
  const state = await harness.request('desktop:create-tab', null, second.id)
  assert.equal(harness.spawns.length, 2)
  assert.equal(harness.spawns[1]!.cwd, targetPath)
  assert.ok(harness.spawns[1]!.args.includes('--continue'))
  assert.equal(harness.spawns[0]!.stopped, false)
  assert.equal(state.activeProfileId, second.id)
  const created = state.tabs.find((tab) => tab.id === state.activeTabId)!
  assert.equal(created.workspaceProfileId, second.id)
  assert.equal(created.sessionPermissionPreset, 'read-only')
  assert.notEqual(created.lastSessionId, SOURCE)
  assert.ok(state.tabs.some((tab) => tab.id === original.activeTabId))
  for (const invalid of ['missing-profile', null, 42]) {
    await assert.rejects(async () => harness.request('desktop:create-tab', 'new', invalid), /workspace profile/)
  }
  assert.equal(harness.spawns.length, 2)
}))

test('failed workspace starts restore consistent selection without overriding a newer session', async () => {
  for (const scenario of ['no-tabs', 'existing-tab', 'newer-session']) await fixture(async (harness, directory) => {
    const first = createWorkspaceProfile(directory)
    const secondPath = join(directory, 'second'); await mkdir(secondPath)
    const thirdPath = join(directory, 'third'); await mkdir(thirdPath)
    const second = createWorkspaceProfile(secondPath), third = createWorkspaceProfile(thirdPath)
    harness.configure({ ...structuredClone(DEFAULT_DESKTOP_CONFIG), profiles: [first, second, third], activeProfileId: first.id }, EMPTY_COPILOT_CAPABILITIES)
    const original = scenario === 'no-tabs' ? null : await harness.createMain()
    let rejectSpawn!: (error: Error) => void, entered!: () => void
    const started = new Promise<void>((resolve) => { entered = resolve })
    harness.setNextSpawn(() => { entered(); return new Promise<void>((_resolve, reject) => { rejectSpawn = reject }) })
    const failed = harness.request('desktop:create-tab', null, second.id)
    const rejection = assert.rejects(failed, /workspace unavailable/)
    await started
    const newer = scenario === 'newer-session' ? await harness.request('desktop:create-tab', null, third.id) : null
    rejectSpawn(new Error('workspace unavailable'))
    await rejection
    const state = await harness.request('desktop:get-state')
    assert.equal(state.activeProfileId, newer ? third.id : first.id)
    assert.equal(state.activeTabId, newer?.activeTabId ?? original?.activeTabId ?? null)
    assert.ok(state.tabs.every((tab) => tab.workspaceProfileId !== second.id))
    assert.ok(harness.spawns.every((spawn) => !spawn.stopped))
    await harness.flushConfig()
    const saved = JSON.parse(await readFile(join(directory, 'desktop.json'), 'utf8'))
    assert.equal(saved.activeProfileId, state.activeProfileId)
    assert.equal(saved.profiles.find((profile: WorkspaceProfile) => profile.id === second.id).tabs.length, 0)
  })
})

test('read-only migration preserves pending sessions, typing and resize while import admission counts pending creation', async () => fixture(async (harness, directory) => {
  const profile = createWorkspaceProfile(directory)
  harness.configure({ ...structuredClone(DEFAULT_DESKTOP_CONFIG), profiles: [profile], activeProfileId: profile.id }, EMPTY_COPILOT_CAPABILITIES)
  let release!: () => void
  harness.blockSpawnPlan(new Promise<void>((resolve) => { release = resolve }))
  const pending = harness.createMain()
  harness.configureMigration(true, false)
  assert.throws(() => harness.checkMigrationIdle(), /Close every Desktop session/)
  release()
  const state = await pending
  await harness.request('desktop:write-tab', state.activeTabId, 'typing during inventory')
  await harness.request('desktop:resize-tab', state.activeTabId, 91, 37)
  assert.ok(harness.spawns[0]!.written.includes('typing during inventory'))
  assert.deepEqual(harness.spawns[0]!.resized.at(-1), [91, 37])
  assert.equal(harness.spawns[0]!.stopped, false)
}))

test('export IPC snapshots settings while a Desktop session stays open and accepts input', async () => fixture(async (harness, directory) => {
  const profile = createWorkspaceProfile(directory)
  harness.configure({ ...structuredClone(DEFAULT_DESKTOP_CONFIG), profiles: [profile], activeProfileId: profile.id }, EMPTY_COPILOT_CAPABILITIES)
  const state = await harness.createMain()
  await writeFile(join(directory, 'settings.json'), '{"model":"live-session-model"}')
  const zip = join(directory, 'snapshot.zip')
  const service = new MigrationService({
    roots: { copilot: directory, desktop: directory, agentSkills: join(directory, 'skills') },
    appVersion: 'test', cliVersion: () => '1.0.82', assertIdle: async () => harness.checkMigrationIdle(),
    plugins: async () => [], exportUsage: async () => {}, restoreUsage: async () => {}, reloaded: async () => {},
    progress: () => { assert.equal(service.exclusive, false) },
  })
  harness.configureMigrationExport(service, zip)
  assert.throws(() => harness.checkMigrationIdle(), /Close every Desktop session/)
  await harness.requestSettings('desktop-settings:migration-export', { categories: ['settings'], projectIds: [] })
  assert.equal(JSON.parse((await readMigrationArchive(zip)).files.find((file) => file.path === 'copilot/settings.json')!.data.toString()).model, 'live-session-model')
  await harness.request('desktop:write-tab', state.activeTabId, 'still running after export')
  assert.ok(harness.spawns[0]!.written.includes('still running after export'))
  assert.equal(harness.spawns[0]!.stopped, false)
}))

test('export IPC silences only expected cancellation from a destroyed Settings sender', async () => fixture(async (harness, directory) => {
  for (const [destroyed, aborted] of [[true, true], [false, true], [true, false]]) {
    const error = aborted ? new DOMException('Cancelled', 'AbortError') : new Error('export failed')
    const service = new MigrationService({
      roots: { copilot: directory, desktop: directory, agentSkills: join(directory, 'skills') },
      appVersion: 'test', cliVersion: () => null, assertIdle: async () => {},
      flushSettings: async () => { if (aborted) service.cancel(); throw error }, plugins: async () => [], exportUsage: async () => {},
      restoreUsage: async () => {}, reloaded: async () => {}, progress: () => {},
    })
    harness.configureMigrationExport(service, join(directory, 'snapshot.zip'), destroyed)
    const request = harness.requestSettings('desktop-settings:migration-export', { categories: ['settings'], projectIds: [] })
    if (destroyed && aborted) assert.equal(await request, false)
    else await assert.rejects(request, (actual) => aborted ? service.isCancellation(actual) : actual === error)
  }
}))

test('closed Settings cancellation is quiet for inventory, archive open and preview', async () => fixture(async (harness, directory) => {
  const zip = join(directory, 'snapshot.zip')
  await writeFile(join(directory, 'copilot-instructions.md'), 'before')
  await writeMigrationArchive(zip, { version: 1, createdAt: new Date().toISOString(), platform: 'win32', appVersion: 'test', cliVersion: null, projects: [], entries: [], warnings: [] }, [fileEntry('copilot/copilot-instructions.md', 'knowledge', Buffer.from('after'))])
  for (const [channel, phase] of [['inventory', 'Discovering files'], ['open', 'Validating archive'], ['preview', 'Preparing import preview']]) {
    let cancelling = false
    const service = new MigrationService({
      roots: { copilot: directory, desktop: directory, agentSkills: join(directory, 'skills') },
      appVersion: 'test', cliVersion: () => null, assertIdle: async () => {}, plugins: async () => [],
      exportUsage: async () => {}, restoreUsage: async () => {}, reloaded: async () => {},
      progress: (value) => { if (cancelling && value.phase === phase) service.cancel() },
    })
    await service.open(zip)
    harness.configureMigrationExport(service, zip, true)
    cancelling = true
    const args = channel === 'inventory' ? [{ categories: ['knowledge'], projectIds: [] }] : channel === 'preview' ? [{ categories: ['knowledge'], replace: [], allowPermissions: false }] : []
    assert.equal(await harness.requestSettings(`desktop-settings:migration-${channel}`, ...args), null)
    assert.equal(service.busy, false)
  }
}))

test('import IPC quiets completed cancellation rollback but preserves failed rollback and live-sender errors', async () => fixture(async (harness, directory) => {
  for (const [index, [destroyed, breakRollback]] of [[true, false], [true, true], [false, false]].entries()) {
    const root = join(directory, String(index)); await mkdir(root)
    const destination = join(root, 'copilot-instructions.md'), zip = join(root, 'snapshot.zip')
    await writeFile(destination, 'before')
    await writeMigrationArchive(zip, { version: 1, createdAt: new Date().toISOString(), platform: 'win32', appVersion: 'test', cliVersion: null, projects: [], entries: [], warnings: [] }, [fileEntry('copilot/copilot-instructions.md', 'knowledge', Buffer.from('after')), fileEntry('copilot/instructions/second.md', 'knowledge', Buffer.from('second write'))])
    const service = new MigrationService({
      roots: { copilot: root, desktop: root, agentSkills: join(root, 'skills') },
      appVersion: 'test', cliVersion: () => null, assertIdle: async () => {}, plugins: async () => [],
      exportUsage: async () => {}, restoreUsage: async () => {}, reloaded: async () => {},
      progress: (value) => { if (value.completed === 1) { if (breakRollback) writeFileSync(destination, 'external change'); service.cancel() } },
    })
    await service.open(zip)
    const preview = await service.preview({ categories: ['knowledge'], replace: ['copilot/copilot-instructions.md'], allowPermissions: false })
    harness.configureMigrationExport(service, zip, destroyed)
    const request = harness.requestSettings('desktop-settings:migration-apply', preview.id)
    if (destroyed && !breakRollback) assert.equal(await request, null)
    else await assert.rejects(request, (error) => error instanceof MigrationImportFailure && service.isCancellation(error) === !breakRollback)
    assert.equal(await readFile(destination, 'utf8'), breakRollback ? 'external change' : 'before')
    assert.equal(service.status().lastImport?.status, breakRollback ? 'failed' : 'cancelled')
  }
}))

test('repeated quit requests wait for the usage backup even with no running sessions', async () => {
  await fixture(async (harness) => {
    let finish!: () => void
    let entered!: () => void
    const stopping = new Promise<void>((resolve) => { entered = resolve })
    const pending = new Promise<void>((resolve) => { finish = resolve })
    harness.configureUsageStop(async () => { entered(); await pending })
    assert.equal(harness.beginQuit(), true)
    await stopping
    assert.equal(harness.beginQuit(), true)
    finish()
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(harness.beginQuit(), false)
  })
})

test('desktop updater cannot spawn its installer before usage flush completes', async () => fixture(async (harness) => {
  const calls: string[] = []
  let finish!: () => void
  let entered!: () => void
  const began = new Promise<void>((resolve) => { entered = resolve })
  const pending = new Promise<void>((resolve) => { finish = resolve })
  let saveConfig!: () => void
  harness.configureBlockedConfig(new Promise<void>((resolve) => { saveConfig = resolve }))
  harness.configureUpdate(async () => { calls.push('usage-start'); entered(); await pending; calls.push('usage-done') }, () => calls.push('installer'))
  const installing = harness.requestSettings('desktop-settings:install-update')
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.deepEqual(calls, [])
  saveConfig()
  await began
  assert.deepEqual(calls, ['usage-start'])
  finish(); await installing
  assert.deepEqual(calls, ['usage-start', 'usage-done', 'installer'])
}))

test('an unavailable usage worker cannot permanently block desktop updates', async () => {
  for (const phase of ['pause', 'flush'] as const) await fixture(async (harness) => {
    let installed = false
    harness.configureUpdate(async () => {}, () => { installed = true })
    harness.configureUsageUnavailable(phase)
    await harness.requestSettings('desktop-settings:install-update')
    assert.equal(installed, true)
  })
})

test('a live collector failure still prevents update installation', async () => fixture(async (harness) => {
  harness.configureUpdate(async () => { throw new Error('source collection failed') }, () => assert.fail('installer must not start'))
  await assert.rejects(harness.requestSettings('desktop-settings:install-update'), /source collection failed/)
  assert.equal(harness.updateBusy(), false)
}))

test('quit during config persistence cancels update preparation quietly', async () => fixture(async (harness) => {
  let save!: () => void
  harness.configureBlockedConfig(new Promise<void>((resolve) => { save = resolve }))
  harness.configureUpdate(async () => {}, () => assert.fail('installer must not start'))
  harness.configureUsageUnavailable('pause')
  const installing = harness.requestSettings('desktop-settings:install-update')
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(harness.beginQuit(), true)
  save(); await installing
  await new Promise<void>((resolve) => setImmediate(resolve))
}))

test('a dismissed dialog settling late cannot clear a newer prompt on the same window', async () => fixture(async (harness) => {
  const window = { isDestroyed: () => false }
  let finishFirst!: (result: { response: number }) => void
  let finishSecond!: (result: { response: number }) => void
  const first = harness.promptClose(window, new Promise((resolve) => { finishFirst = resolve }))
  harness.dismissClosePrompt()
  const second = harness.promptClose(window, new Promise((resolve) => { finishSecond = resolve }))
  assert.equal(harness.beginQuit(), true)
  finishFirst({ response: 1 }); await first
  assert.equal(harness.closePromptDismissed(), false)
  assert.equal(harness.quitPendingOnPrompt(), true)
  finishSecond({ response: 1 }); await second
  assert.equal(harness.closePromptDismissed(), true)
  assert.equal(harness.quitPendingOnPrompt(), false)
}))

test('quit during update preparation waits for the shared collector and cancels installation', async () => fixture(async (harness) => {
  let finish!: () => void
  let entered!: () => void
  const began = new Promise<void>((resolve) => { entered = resolve })
  const pending = new Promise<void>((resolve) => { finish = resolve })
  let installed = false
  harness.configureUpdate(async () => { entered(); await pending }, () => { installed = true })
  const installing = harness.requestSettings('desktop-settings:install-update')
  await began
  assert.equal(harness.beginQuit(), true)
  harness.updateError()
  assert.equal(harness.beginQuit(), true)
  finish(); await installing
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(installed, false)
  assert.equal(harness.beginQuit(), false)
}))

test('updater errors during a flush retain the install interlock until preparation settles', async () => fixture(async (harness) => {
  let finish!: () => void
  let entered!: () => void
  const began = new Promise<void>((resolve) => { entered = resolve })
  const pending = new Promise<void>((resolve) => { finish = resolve })
  harness.configureUpdate(async () => { entered(); await pending }, () => assert.fail('installer must not start'))
  const installing = assert.rejects(harness.requestSettings('desktop-settings:install-update'), /failed while preparing/)
  await began; harness.updateError()
  assert.equal(harness.updateBusy(), true)
  await assert.rejects(harness.requestSettings('desktop-settings:install-update'), /already in progress/)
  finish(); await installing
  assert.equal(harness.updateBusy(), false)
}))

test('a no-op installer releases the admission lock without stopping collection', async (t) => fixture(async (harness) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let flushes = 0
  harness.configureUpdate(async () => { flushes++ }, () => {})
  await harness.requestSettings('desktop-settings:install-update')
  assert.equal(harness.updateBusy(), true)
  t.mock.timers.tick(10_001)
  assert.equal(harness.updateBusy(), false)
  await harness.requestSettings('desktop-settings:install-update')
  assert.equal(flushes, 2)
}))

test('a stuck pre-install flush returns an error without launching an unprotected installer', async (t) => fixture(async (harness) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let installed = false
  harness.configureUpdate(() => new Promise(() => {}), () => { installed = true })
  const installing = assert.rejects(harness.requestSettings('desktop-settings:install-update'), /deadline/)
  await new Promise<void>((resolve) => setImmediate(resolve))
  t.mock.timers.tick(30_001)
  await installing
  assert.equal(installed, false)
  assert.equal(harness.updateBusy(), false)
}))

test('check and download requests cannot interfere with update preparation', async () => fixture(async (harness) => {
  let finish!: () => void
  const pending = new Promise<void>((resolve) => { finish = resolve })
  harness.configureUpdate(() => pending, () => {})
  const installing = harness.requestSettings('desktop-settings:install-update')
  await assert.rejects(harness.requestSettings('desktop-settings:check-for-updates'), /already in progress/)
  await assert.rejects(harness.requestSettings('desktop-settings:download-update'), /already in progress/)
  finish(); await installing
}))

test('an updater quit dismisses the close prompt and cannot be mistaken for a failed install', async (t) => fixture(async (harness) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  harness.configureUpdate(async () => {}, () => {})
  await harness.requestSettings('desktop-settings:install-update')
  harness.configureClosePrompt()
  assert.equal(harness.beginQuit(), true)
  assert.equal(harness.closePromptDismissed(), true)
  assert.equal(harness.updateBusy(), true)
  t.mock.timers.tick(10_001)
  assert.equal(harness.updateBusy(), true)
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(harness.beginQuit(), false)
  await assert.rejects(harness.requestSettings('desktop-settings:install-update'), /already in progress/)
}))

test('usage failures neither block CLI maintenance nor misreport a successful CLI update', async () => fixture(async (harness) => {
  harness.configureMaintenance()
  await harness.maintain('install')
  assert.equal(harness.maintenanceStatus(), 'succeeded')
  await harness.maintain('update')
  assert.equal(harness.maintenanceStatus(), 'succeeded')
  assert.deepEqual(harness.maintenanceCalls, ['install', 'retry-resolution', 'update', 'retry-resolution'])
}))

test('overall quit deadline releases repeated exit requests despite a stuck config write', async (t) => fixture(async (harness) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let finish!: () => void
  harness.configureUsageStop(async () => {})
  harness.configureBlockedConfig(new Promise<void>((resolve) => { finish = resolve }))
  try {
    assert.equal(harness.beginQuit(), true)
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(harness.beginQuit(), true)
    t.mock.timers.tick(30_001)
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(harness.beginQuit(), false)
  } finally { finish(); t.mock.timers.reset() }
}))

function configure(harness: Harness, directory: string) {
  const profile = createWorkspaceProfile(directory, 'default')
  const capabilities = { ...EMPTY_COPILOT_CAPABILITIES, sessionIdentity: true, toolAllowlist: true,
    supportedOptions: ['--mode', '--agent', '--worktree', '--remote', '--remote-export', '--no-remote', '--no-remote-export'] }
  harness.configure({ ...DEFAULT_DESKTOP_CONFIG, profiles: [profile], activeProfileId: profile.id }, capabilities)
  return { profile, capabilities }
}

function assertRestricted(args: string[]): void {
  assert.ok(args.includes('--available-tools=view,glob,grep,ask_user'))
  assert.ok(args.includes('--mode=interactive'))
  assert.ok(args.includes('--no-remote') && args.includes('--no-remote-export'))
  for (const forbidden of ['--allow-all', '--autopilot', 'autopilot', '--agent', '--worktree']) assert.ok(!args.includes(forbidden), `Unexpected launch arg: ${forbidden}`)
}

test('session launch keeps the inherited PATH when adding the Copilot runtime directory', async () => {
  await fixture(async (harness, directory) => {
    configure(harness, directory)
    const pathKey = Object.keys(process.env).find((name) => name.toLowerCase() === 'path') ?? 'Path'
    const inheritedPath = process.env[pathKey] ?? ''

    await harness.createMain()

    assert.equal(
      harness.spawns[0]?.env[pathKey],
      ['C:/Program Files/nodejs', inheritedPath].filter(Boolean).join(';'),
    )
  })
})

test('session launch protects credentials inherited from the ambient environment', async () => {
  const name = 'DESKTOP_LIFECYCLE_TEST_TOKEN'
  const previous = process.env[name]
  process.env[name] = 'test-only-secret'
  try {
    await fixture(async (harness, directory) => {
      configure(harness, directory)
      await harness.createMain()
      assert.ok(harness.spawns[0]?.args.includes(`--secret-env-vars=${name}`))
    })
  } finally {
    if (previous === undefined) delete process.env[name]
    else process.env[name] = previous
  }
})

test('restart IPC reapplies side-chat restrictions after profile escalation, before stopping the old PTY', async () => {
  await fixture(async (harness, directory) => {
    const { profile, capabilities } = configure(harness, directory)
    const main = await harness.createMain()
    const opened = await harness.createSide(profile, main.activeTabId!)
    const sideId = opened.activeTabId!
    profile.permissionPreset = 'full-access'
    profile.launch = { ...profile.launch, mode: 'autopilot', agent: 'writer', worktree: true, remoteControl: 'enable', remoteExport: 'enable' }
    const restarted = await harness.request('desktop:restart-tab', sideId)
    assert.equal(harness.spawns.length, 3)
    assertRestricted(harness.spawns[2]!.args)
    assert.equal(harness.spawns[0]!.stopped, false)
    assert.equal(harness.spawns[1]!.stopped, true)
    assert.equal(restarted.tabs.find((tab) => tab.id === sideId)?.sessionPermissionPreset, 'read-only')
    assert.equal(restarted.tabs.find((tab) => tab.id === sideId)?.lastSessionId, FORK)
    capabilities.toolAllowlist = false
    await assert.rejects(harness.request('desktop:restart-tab', sideId), /tool allowlists/)
    assert.equal(harness.spawns.length, 3)
    assert.equal(harness.spawns[2]!.stopped, false)
  })
})

test('restored side chats remain restricted under a full-access autopilot workspace', async () => {
  await fixture(async (harness, directory) => {
    const { profile } = configure(harness, directory)
    profile.permissionPreset = 'full-access'
    profile.launch.mode = 'autopilot'
    profile.tabs = [{ title: 'Main', lastSessionId: SOURCE }, { title: 'Side', lastSessionId: FORK, sideChat: true, sideParentSessionId: SOURCE }]
    await harness.restore()
    const state = await harness.request('desktop:get-state')
    assert.equal(state.tabs.length, 2)
    assert.ok(harness.spawns[0]!.args.includes('--allow-all'), 'resume preserves the original startup baseline')
    assertRestricted(harness.spawns[1]!.args)
    assert.equal(state.tabs[1]!.sideParentTabId, state.tabs[0]!.id)
    assert.equal(state.tabs[1]!.sessionPermissionPreset, 'read-only')
  })
})

test('duplicate fork IPC reports existing side chat instead of ignoring UUID/title and changing focus', async () => {
  await fixture(async (harness, directory) => {
    const { profile } = configure(harness, directory)
    const main = await harness.createMain()
    const opened = await harness.createSide(profile, main.activeTabId!)
    await harness.request('desktop:activate-tab', main.activeTabId)
    await assert.rejects(harness.request('desktop:fork-side-chat', main.activeTabId, SOURCE, 'Different title'), /already has a side chat/)
    const after = await harness.request('desktop:get-state')
    assert.equal(after.activeTabId, main.activeTabId)
    assert.deepEqual(after.tabs.map((tab) => [tab.id, tab.title, tab.lastSessionId]), opened.tabs.map((tab) => [tab.id, tab.title, tab.lastSessionId]))
    assert.equal(harness.spawns.length, 2)
  })
})

test('concurrent profile restoration coalesces to one set of session processes', async () => {
  await fixture(async (harness, directory) => {
    const { profile } = configure(harness, directory)
    profile.tabs = [{ title: 'Main', lastSessionId: SOURCE }, { title: 'Side', lastSessionId: FORK, sideChat: true, sideParentSessionId: SOURCE }]
    await Promise.all([harness.restore(), harness.restore()])
    const state = await harness.request('desktop:get-state')
    assert.equal(state.tabs.length, 2)
    assert.equal(harness.spawns.length, 2)
  })
})

test('quit admission prevents a zero-tab pending creation from spawning', async () => {
  await fixture(async (harness, directory) => {
    configure(harness, directory)
    harness.beginQuit()
    await assert.rejects(() => harness.createMain(), /shutting down/)
    assert.equal(harness.spawns.length, 0)
  })
})

test('file reveal rejects a syntactically valid but nonexistent session tab', async () => {
  await fixture(async (harness, directory) => {
    configure(harness, directory)
    await assert.rejects(
      () => harness.request('desktop:reveal-path', 'tab-999', 'C:\\Windows\\notepad.exe'),
      /Invalid session tab/,
    )
  })
})

test('file reveal rejects paths outside the session workspace', async () => {
  await fixture(async (harness, directory) => {
    configure(harness, directory)
    const state = await harness.createMain()
    await assert.rejects(
      () => harness.request('desktop:reveal-path', state.activeTabId, '..\\outside.txt'),
      /within the session workspace/,
    )
  })
})

test('profile permission edits affect new sessions but restart preserves an existing session permission', async () => {
  await fixture(async (harness, directory) => {
    const { profile } = configure(harness, directory)
    const opened = await harness.createMain()
    profile.permissionPreset = 'full-access'

    const restarted = await harness.request('desktop:restart-tab', opened.activeTabId)

    assert.equal(harness.spawns.length, 2)
    assert.ok(!harness.spawns[1]!.args.includes('--allow-all'))
    assert.equal(restarted.tabs[0]?.sessionPermissionPreset, 'default')
  })
})

test('default auto-resume mints an id when it actually starts a fresh session', async () => {
  await fixture(async (harness, directory) => {
    configure(harness, directory)
    const opened = await harness.createMain()
    const sessionId = opened.tabs[0]?.lastSessionId
    assert.ok(sessionId)
    assert.ok(harness.spawns[0]?.args.includes(`--session-id=${sessionId}`))

    const sessionDirectory = join(directory, 'session-state', sessionId)
    await mkdir(sessionDirectory, { recursive: true })
    await writeFile(join(sessionDirectory, 'events.jsonl'), '{"type":"session.permissions_changed","data":{"allowAllPermissionMode":"auto","allowAllPermissions":false}}\n')
    harness.spawns[0]!.emitData('\u001b[?25h')
    await new Promise((resolve) => setTimeout(resolve, 150))
    const changed = await harness.request('desktop:get-state')
    assert.equal(changed.tabs[0]?.sessionPermissionMode, 'assisted')
  })
})

test('restored sessions use their persisted permission instead of the current profile default', async () => {
  await fixture(async (harness, directory) => {
    const { profile } = configure(harness, directory)
    profile.permissionPreset = 'read-only'
    profile.defaultResumeMode = 'new'
    profile.tabs = [{ title: 'Existing', lastSessionId: SOURCE, sessionPermissionPreset: 'full-access' }]

    await harness.restore()
    const state = await harness.request('desktop:get-state')

    assert.ok(harness.spawns[0]!.args.includes('--allow-all'))
    assert.ok(!harness.spawns[0]!.args.some((arg) => arg.startsWith('--available-tools=')))
    assert.equal(state.tabs[0]?.sessionPermissionPreset, 'full-access')
  })
})

test('structured permission events update only the session and resume without replaying mode as a baseline flag', async () => {
  await fixture(async (harness, directory) => {
    const { profile } = configure(harness, directory)
    profile.permissionPreset = 'read-only'
    profile.defaultResumeMode = 'new'
    const opened = await harness.createMain()
    const tabId = opened.activeTabId!

    const sessionId = opened.tabs[0]!.lastSessionId!
    const sessionDirectory = join(directory, 'session-state', sessionId)
    await mkdir(sessionDirectory, { recursive: true })
    await writeFile(join(sessionDirectory, 'events.jsonl'), '{"type":"session.permissions_changed","data":{"allowAllPermissionMode":"on","allowAllPermissions":true}}\n')
    harness.spawns[0]!.emitData('\u001b[?25h')
    await new Promise((resolve) => setTimeout(resolve, 150))
    const changed = await harness.request('desktop:get-state')

    assert.equal(profile.permissionPreset, 'read-only')
    assert.equal(changed.tabs[0]?.sessionPermissionPreset, 'read-only')
    assert.equal(changed.tabs[0]?.sessionPermissionMode, 'allow-all')
    assert.equal(harness.spawns.length, 1)

    const restarted = await harness.request('desktop:restart-tab', tabId)
    assert.equal(restarted.tabs[0]?.lastSessionId, sessionId)
    assert.equal(restarted.tabs[0]?.sessionPermissionPreset, 'read-only')
    assert.equal(restarted.tabs[0]?.sessionPermissionMode, 'allow-all')
    assert.equal(harness.spawns.length, 2)
    assert.ok(!harness.spawns[1]!.args.includes('--allow-all'))
    assert.ok(harness.spawns[1]!.args.some((arg) => arg.startsWith('--available-tools=')))
  })
})

test('side-chat runtime mode is displayed but never persisted or replayed as a launch flag', async () => {
  await fixture(async (harness, directory) => {
    const { profile } = configure(harness, directory)
    const main = await harness.createMain()
    const opened = await harness.createSide(profile, main.activeTabId!)
    const sideId = opened.activeTabId!
    const sessionDirectory = join(directory, 'session-state', FORK)
    await mkdir(sessionDirectory, { recursive: true })
    await writeFile(join(sessionDirectory, 'events.jsonl'), '{"type":"session.permissions_changed","data":{"allowAllPermissionMode":"on","allowAllPermissions":true}}\n')
    harness.spawns[1]!.emitData('\u001b[?25h')
    await new Promise((resolve) => setTimeout(resolve, 150))

    const changed = await harness.request('desktop:get-state')
    assert.equal(changed.tabs.find((tab) => tab.id === sideId)?.sessionPermissionMode, 'allow-all')
    assert.equal(profile.tabs.find((tab) => tab.sideChat)?.sessionPermissionMode, undefined)

    await harness.request('desktop:restart-tab', sideId)
    assertRestricted(harness.spawns[2]!.args)
  })
})

test('remote tabs are never persisted as restorable local sessions', async () => {
  await fixture(async (harness, directory) => {
    const { profile, capabilities } = configure(harness, directory)
    profile.permissionPreset = 'read-only'
    capabilities.remoteSessions = true
    const state = await harness.request('desktop:connect-remote-session', 'remote-session-1')
    assert.equal(state.tabs[0]?.remote, true)
    assert.equal(state.tabs[0]?.sessionPermissionPreset, null)
    assert.ok(!harness.spawns[0]!.args.some((arg) => arg.startsWith('--available-tools=')))
    assert.deepEqual(profile.tabs, [])
  })
})

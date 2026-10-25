import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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
import { realPathNative } from './real-path.js'
import { findGitForTests } from './fixtures/git-fixture.js'

const SOURCE = '11111111-1111-4111-8111-111111111111'
const FORK = '22222222-2222-4222-8222-222222222222'
interface Harness {
  shellCalls: { action: string; target: string }[]
  createTestWindow(): void
  /** Answer every native message box with this button, and collect what each one asked. */
  answerMessageBoxes(response: number, beforeAnswer?: () => void): { title: string; detail: string; buttons: string[] }[]
  /** Settles once every worktree cleanup started by a tab close has finished. */
  worktreeCleanups(): Promise<void>
  refreshAppMenu(): void
  quitCalls(): number
  windowFor(tabId?: string): { destroyed: boolean; focused: number; title: string; menu: unknown; messages: { channel: string; payload: any }[]; close(): void; webContents: { emit(name: string): void } }
  requestIn(tabId: string, name: string, ...args: unknown[]): Promise<any>
  configureMigration(busy: boolean, exclusive: boolean): void
  configureMigrationExport(service: MigrationService, path: string, senderDestroyed?: boolean): void
  configureBrowserExportDialog(result: { canceled: boolean; filePath?: string }): void
  blockSpawnPlan(work: Promise<void>): void
  /** Like blockSpawnPlan, but only plans for a profile the predicate accepts wait; the others run at once. */
  blockSpawnPlanWhen(accept: (profile: WorkspaceProfile) => boolean, work: Promise<void>): void
  /** Dormant tabs' reads of their saved session's folder wait for `work`. */
  blockDormantFolderReads(work: Promise<void>): void
  setNextSpawn(work: () => Promise<void>): void
  flushConfig(): Promise<void>
  checkMigrationIdle(): void
  configure(config: DesktopConfig, capabilities: CopilotCapabilities): void
  createMain(): Promise<DesktopState>
  /** One pass of the session-name poll, which the app runs every few seconds once ready. */
  refreshNames(): Promise<void>
  createSide(profile: WorkspaceProfile, parentId: string): Promise<DesktopState>
  restore(): Promise<void>
  restoreSaved(): Promise<void>
  beginQuit(): boolean
  waitForQuit(): Promise<void>
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
  requestWithFrame(name: string, frameUrl: string): Promise<unknown>
  browserBounds(): unknown
  browserConfigs: { settings: string; options: { partition: string; endpointPath: string; devtoolsPartition?: string } }[]
  browserStorageClears: { partition: string; operation: string }[]
  blockBrowserDispose(work: Promise<void>, started: () => void): void
  request<T = DesktopState>(name: string, ...args: unknown[]): Promise<T>
  cleanup(): Promise<void>
  spawns: { args: string[]; cwd: string; env: NodeJS.ProcessEnv; worktreeTimeoutMinutes?: number; stopped: boolean; written: string[]; resized: number[][]; emitData(data: string): void }[]
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
      './browser-debug.js': `
        export let lastBounds;
        export const browserConfigs = [];
        let disposeWork, disposeStarted;
        export function blockBrowserDispose(work, started) { disposeWork = work; disposeStarted = started; }
        export class BrowserDebug {
          constructor(owner, settings, options) { browserConfigs.push({ settings, options }); }
          snapshot = { url: '', console: [], network: [] };
          async open() { return this.snapshot; }
          async navigate(url) { this.snapshot.url = url; return this.snapshot; }
          action() { return this.snapshot; }
          setBounds(bounds) { lastBounds = bounds; }
          setOwner() {}
          async dispose() { const work = disposeWork; disposeWork = null; disposeStarted?.(); disposeStarted = null; await work; }
        }
      `,
      electron: `
        import { EventEmitter } from 'node:events';
        export const app = Object.assign(new EventEmitter(), { quitCalls: 0, requestSingleInstanceLock: () => false, quit() { this.quitCalls++; }, getPath: () => ${JSON.stringify(directory)}, getAppPath: () => ${JSON.stringify(directory)}, getVersion: () => '0.1.44' });
        const handlers = new Map();
        export const ipcMain = { handle: (name, handler) => handlers.set(name, handler), invoke: (name, ...args) => handlers.get(name)(...args) };
        const allWindows = []; let applicationMenu = null;
        export const Menu = {
          getApplicationMenu: () => applicationMenu,
          buildFromTemplate: template => template,
          setApplicationMenu(menu) { applicationMenu = menu; for (const window of allWindows) if (!window.destroyed) window.setMenu(menu); },
        };
        export const BrowserWindow = class extends EventEmitter {
          destroyed = false; focused = 0; title = ''; messages = [];
          constructor(options = {}) { super(); this.title = options.title || ''; allWindows.push(this); }
          static getFocusedWindow() { return null; }
          static fromWebContents(contents) { return allWindows.find(window => window.webContents === contents && !window.destroyed) || null; }
          webContents = Object.assign(new EventEmitter(), {
            getURL: () => this.url || '',
            send: (channel, payload) => this.messages.push({ channel, payload }),
            setWindowOpenHandler() {},
            session: { setPermissionCheckHandler() {}, setPermissionRequestHandler() {} },
          });
          setMenu(menu) { this.menu = menu; } setTitle(title) { this.title = title; }
          isDestroyed() { return this.destroyed; } isMinimized() { return false; } isFocused() { return false; } isVisible() { return true; }
          show() {} focus() { this.focused++; this.emit('focus'); } restore() {}
          async loadFile(path) {
            this.url = (await import('node:url')).pathToFileURL(path).href;
            let prevented = false;
            this.emit('page-title-updated', { preventDefault() { prevented = true; } }, 'Copilot CLI Desktop');
            if (!prevented) this.title = 'Copilot CLI Desktop';
          }
          close() { this.destroy(); }
          destroy() { if (!this.destroyed) { this.destroyed = true; this.emit('closed'); } }
        };
        export const clipboard = {}, dialog = {}, globalShortcut = { isRegistered: () => false }, Notification = {}, safeStorage = {}, Tray = {};
        export const browserStorageClears = [];
        export const session = { fromPartition(partition) {
          return Object.fromEntries(['closeAllConnections', 'clearData', 'clearCache', 'clearAuthCache'].map(operation =>
            [operation, async () => { browserStorageClears.push({ partition, operation }); }]));
        } };
        // Browser rendering is exercised by browser-debug-check.mjs in real
        // Electron; existing session lifecycle tests never instantiate this view.
        export const WebContentsView = class {};
        export const shell = {
          calls: [],
          showItemInFolder(target) { this.calls.push({ action: 'reveal', target }); },
          async openExternal(target) { this.calls.push({ action: 'open', target }); },
          async trashItem(target) { this.calls.push({ action: 'trash', target }); (await import('node:fs')).rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); },
        };
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
          const record = { args, cwd: options.cwd, env: options.env, worktreeTimeoutMinutes: options.worktreeTimeoutMinutes, stopped: false, written: [], resized: [], emitData(data) { for (const fn of dataListeners) fn(data); } };
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
    assert.ok(source.includes('void withShutdownDeadline(stopAllSessions()'))
    const testSource = source.replace('void withShutdownDeadline(stopAllSessions()', 'quitCleanupForTest = withShutdownDeadline(quitWorkForTest = stopAllSessions()')
    const bundle = await build({
      stdin: { contents: testSource + `
        let quitCleanupForTest, quitWorkForTest;
        import { spawns, setNextSpawn } from './node-pty-backend.js';
        import { maintenanceCalls } from './copilot-maintenance.js';
        import { lastBounds, blockBrowserDispose, browserConfigs } from './browser-debug.js';
        import { browserStorageClears } from 'electron';
        const diagnosticWrites = [];
        let settingsSenderDestroyed = false;
        const originalWriteAppLog = writeAppLog;
        writeAppLog = (...args) => { const work = originalWriteAppLog(...args); diagnosticWrites.push(work); return work; };
        export const lifecycleTest = {
          shellCalls: shell.calls,
          createTestWindow() { mainWindow = createWindow(false); mainWindow.url = shellUrl(); },
          refreshAppMenu: installApplicationMenu,
          quitCalls: () => app.quitCalls,
          windowFor: (tabId) => tabId ? sessionWindows.get(tabId) : mainWindow,
          requestIn: (tabId, name, ...args) => ipcMain.invoke(name, { senderFrame: { url: shellUrl() }, sender: sessionWindows.get(tabId).webContents }, ...args),
          configureMigration(busy, exclusive) { migrationService = { busy, exclusive }; },
          configureMigrationExport(service, path, senderDestroyed = false) { migrationService = service; settingsSenderDestroyed = senderDestroyed; dialog.showSaveDialog = async () => ({ canceled: false, filePath: path }); dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }); },
          configureBrowserExportDialog(result) { dialog.showSaveDialog = async (owner) => { if (!owner || owner.isDestroyed()) throw new Error('Missing live export owner'); return result; }; },
          blockSpawnPlan(work) { const original = buildSessionSpawnPlan; buildSessionSpawnPlan = async (...args) => { await work; return original(...args); }; },
          blockSpawnPlanWhen(accept, work) { const original = buildSessionSpawnPlan; buildSessionSpawnPlan = async (...args) => { if (accept(args[0])) await work; return original(...args); }; },
          blockDormantFolderReads(work) { const original = applyDormantSessionCwd; applyDormantSessionCwd = async (...args) => { await work; return original(...args); }; },
          checkMigrationIdle,
          spawns,
          setNextSpawn,
          flushConfig: () => configWriteQueue,
          maintenanceCalls,
          configure(config, capabilities) { desktopConfig = config; copilotCapabilities = capabilities;
            state.resolution = { kind: 'direct', command: 'inert-pty', prefixArgs: [], resolvedPath: null, version: '1.0.82', error: null, pathAdditions: ['C:/Program Files/nodejs'] }; syncWorkspaceState(); },
          createMain: () => createSessionTab(),
          refreshNames: () => refreshSessionNames(),
          createSide: (profile, parentId) => createSessionTab(profile, 'auto-resume', '${FORK}', [], null, 'Side', { sideChat: true, sideParentTabId: parentId }),
          restore: restoreTabsForProfile,
          restoreSaved: restoreSavedWorkspaceTabs,
          beginQuit() { let prevented = false; app.emit('before-quit', { preventDefault() { prevented = true; } }); return prevented; },
          waitForQuit: async () => { await quitCleanupForTest; },
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
          answerMessageBoxes(response, beforeAnswer) { const asked = []; dialog.showMessageBox = async (_window, options) => { asked.push(options); beforeAnswer?.(); return { response }; }; return asked; },
          worktreeCleanups: () => worktreeCleanupQueue,
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
          requestWithFrame: async (name, frameUrl) => ipcMain.invoke(name, { senderFrame: { url: frameUrl }, sender: mainWindow?.webContents }),
          browserBounds: () => lastBounds,
          browserConfigs,
          browserStorageClears,
          blockBrowserDispose,
          request: (name, ...args) => ipcMain.invoke(name, { senderFrame: { url: shellUrl() }, sender: mainWindow?.webContents }, ...args),
          async cleanup() { clearTimeout(updateQuitTimer); await stopAllSessions(); await configWriteQueue; await quitCleanupForTest; await quitWorkForTest; await Promise.allSettled(diagnosticWrites); },
        };
      `, resolveDir: dirname(mainPath), loader: 'js' },
      bundle: true, platform: 'node', format: 'esm', packages: 'external', write: false,
      plugins: [{ name: 'inert-os-boundaries', setup(builder) {
        builder.onResolve({ filter: /^(electron|electron-updater|\.\/(browser-debug|node-pty-backend|resolve-copilot|copilot-maintenance|migration-service|migration-import|migration-writers)\.js)$/ }, (args) => ({ path: args.path, namespace: 'test-boundary' }))
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

test('worktree timeout settings validate and persist, and new sessions and restarts use the latest value', async () => fixture(async (harness, directory) => {
  const { profile } = configure(harness, directory)
  profile.defaultResumeMode = 'new'
  harness.configure({ ...DEFAULT_DESKTOP_CONFIG, trayEnabled: false, profiles: [profile], activeProfileId: profile.id },
    { ...EMPTY_COPILOT_CAPABILITIES, sessionIdentity: true, toolAllowlist: true })
  const first = await harness.createMain()
  assert.equal(harness.spawns[0]!.worktreeTimeoutMinutes, 10)
  for (const value of [0, -1, 1.5, 1441, '25', null]) {
    await assert.rejects(harness.requestSettings('desktop-settings:update-preferences', { worktreeTimeoutMinutes: value }), /Invalid desktop preferences/)
  }
  const saved = await harness.requestSettings('desktop-settings:update-preferences', { worktreeTimeoutMinutes: 25 }) as { worktreeTimeoutMinutes: number }
  assert.equal(saved.worktreeTimeoutMinutes, 25)
  await harness.flushConfig()
  assert.equal(JSON.parse(await readFile(join(directory, 'desktop.json'), 'utf8')).worktreeTimeoutMinutes, 25)
  await harness.request('desktop:create-tab', 'new', profile.id)
  assert.equal(harness.spawns.at(-1)!.worktreeTimeoutMinutes, 25)
  assert.equal(harness.spawns[0]!.worktreeTimeoutMinutes, 10, 'an in-flight launch keeps its captured timeout')
  await harness.request('desktop:restart-tab', first.activeTabId)
  assert.equal(harness.spawns.at(-1)!.worktreeTimeoutMinutes, 25)
}))

test('production browser IPC validates session ownership, frames, bounds and shutdown', async () => fixture(async (harness, directory) => {
  configure(harness, directory)
  harness.createTestWindow()
  const tab = (await harness.createMain()).activeTabId!
  await harness.request('desktop:browser-open', tab)
  for (const channel of ['open', 'state', 'navigate', 'action', 'bounds', 'export']) {
    await assert.rejects(harness.requestWithFrame(`desktop:browser-${channel}`, 'https://untrusted.test'), /untrusted renderer/)
    await assert.rejects(async () => harness.requestSettings(`desktop:browser-${channel}`), /untrusted renderer/)
  }
  await assert.rejects(async () => harness.request('desktop:browser-open', 'tab-999'), /Unknown browser session/)
  await harness.request('desktop:browser-bounds', tab, { x: 5, y: 10, width: 500, height: 600 })
  assert.deepEqual(harness.browserBounds(), { x: 5, y: 10, width: 500, height: 600 })
  await harness.request('desktop:pop-out-tab', tab)
  await harness.requestIn(tab, 'desktop:browser-state', tab)
  await assert.rejects(async () => harness.request('desktop:browser-state', tab), /owning session window/)
  for (const bounds of [{ x: -1, y: 0, width: 1, height: 1 }, { x: 0, y: 0, width: Infinity, height: 1 },
    { x: 0, y: 0, width: 20001, height: 1 }, {}, 'bad']) {
    await assert.rejects(async () => harness.requestIn(tab, 'desktop:browser-bounds', tab, bounds), /Invalid browser bounds/)
  }
  await harness.requestIn(tab, 'desktop:browser-bounds', tab, null)
  assert.equal(harness.browserBounds(), null)
  await assert.rejects(async () => harness.requestIn(tab, 'desktop:browser-navigate', tab, 123), /Invalid browser URL/)
  await assert.rejects(async () => harness.requestIn(tab, 'desktop:browser-navigate', tab, 'x'.repeat(8193)), /Invalid browser URL/)
  await assert.rejects(async () => harness.requestIn(tab, 'desktop:browser-action', tab, {}), /Invalid browser action/)
  harness.beginQuit()
  await assert.rejects(async () => harness.requestIn(tab, 'desktop:browser-state', tab), /owning session window/)
}))

test('captured browser log export uses the owning session snapshot and respects cancellation', async () => fixture(async (harness, directory) => {
  configure(harness, directory)
  harness.createTestWindow()
  const tab = (await harness.createMain()).activeTabId!
  // Seed the native browser stub; rendering/capture/redaction are checked in real Electron.
  const browser = await harness.request<any>('desktop:browser-open', tab)
  browser.console.push({ pageId: 12, message: 'exception token=[redacted]' })
  browser.network.push({ pageId: 12, url: 'http://localhost/api?token=[redacted]' })
  const path = join(directory, 'browser-log.json')
  harness.configureBrowserExportDialog({ canceled: false, filePath: path })
  await harness.request('desktop:browser-export', tab, 'console')
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), browser.console)
  await assert.rejects(harness.request('desktop:browser-export', tab, '../secret'), /Invalid browser export/)
  await harness.request('desktop:pop-out-tab', tab)
  await assert.rejects(harness.request('desktop:browser-export', tab, 'network'), /owning session window/)
  await harness.requestIn(tab, 'desktop:browser-export', tab, 'network')
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), browser.network)
  harness.configureBrowserExportDialog({ canceled: true, filePath: path })
  await harness.requestIn(tab, 'desktop:browser-export', tab, 'console')
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), browser.network, 'cancel does not overwrite an existing log')
}))

test('browser IPC and CLI environments stay tied to their session through switches, restart and close', async () => fixture(async (harness, directory) => {
  configure(harness, directory)
  harness.createTestWindow()
  const first = (await harness.createMain()).activeTabId!
  await harness.request('desktop:browser-open', first)
  await harness.request('desktop:browser-navigate', first, 'https://first.example/')
  const second = (await harness.createMain()).activeTabId!
  await harness.request('desktop:browser-open', second)
  await harness.request('desktop:browser-navigate', second, 'https://second.example/')
  assert.equal((await harness.request<{ url: string }>('desktop:browser-state', first)).url, 'https://first.example/')
  assert.equal((await harness.request<{ url: string }>('desktop:browser-state', second)).url, 'https://second.example/')
  assert.notEqual(harness.spawns[0]!.env.COPILOT_DESKTOP_BROWSER_STATE, harness.spawns[1]!.env.COPILOT_DESKTOP_BROWSER_STATE)
  assert.ok(harness.spawns[0]!.env.COPILOT_DESKTOP_BROWSER_HELPER)
  await harness.request('desktop:activate-tab', first)
  await harness.request('desktop:restart-tab', first)
  assert.equal(harness.spawns[2]!.env.COPILOT_DESKTOP_BROWSER_STATE, harness.spawns[0]!.env.COPILOT_DESKTOP_BROWSER_STATE)
  assert.equal((await harness.request<{ url: string }>('desktop:browser-state', first)).url, 'https://first.example/')
  let finishDispose!: () => void
  let disposeStarted!: () => void
  const disposing = new Promise<void>(accept => { disposeStarted = accept })
  harness.blockBrowserDispose(new Promise<void>(accept => { finishDispose = accept }), disposeStarted)
  const closing = harness.request('desktop:close-tab', first)
  await disposing
  assert.equal((await harness.request<{ url: string }>('desktop:browser-state', first)).url, 'https://first.example/', 'polling during close must not recreate a browser')
  finishDispose()
  await closing
  await assert.rejects(async () => harness.request('desktop:browser-state', first), /Unknown browser session/)
  assert.equal((await harness.request<{ url: string }>('desktop:browser-state', second)).url, 'https://second.example/')
}))

test('pop-out transfers terminal ownership, focuses one window, and docks without stopping the CLI', async () => fixture(async (harness, directory) => {
  const profile = createWorkspaceProfile(directory)
  harness.configure({ ...structuredClone(DEFAULT_DESKTOP_CONFIG), notifications: false, profiles: [profile], activeProfileId: profile.id }, EMPTY_COPILOT_CAPABILITIES)
  harness.createTestWindow()
  const initial = await harness.createMain()
  const id = initial.activeTabId!
  harness.spawns[0]!.emitData('before move\r\n')
  const detached = await harness.request('desktop:pop-out-tab', id)
  assert.deepEqual(detached.poppedOutTabIds, [id])
  const window = harness.windowFor(id)
  await harness.request('desktop:pop-out-tab', id)
  assert.equal(harness.windowFor(id), window)
  const focusCount = window.focused
  await harness.request('desktop:activate-tab', id)
  assert.equal(window.focused, focusCount + 1)
  assert.equal((await harness.requestIn(id, 'desktop:get-state')).windowSessionId, id)
  await harness.request('desktop:write-tab', id, 'stale main input')
  await harness.request('desktop:resize-tab', id, 10, 10)
  assert.deepEqual(harness.spawns[0]!.written, [])
  assert.deepEqual(harness.spawns[0]!.resized, [])
  await harness.requestIn(id, 'desktop:write-tab', id, 'popout input')
  await harness.requestIn(id, 'desktop:resize-tab', id, 123, 45)
  assert.deepEqual(harness.spawns[0]!.written, ['popout input'])
  assert.deepEqual(harness.spawns[0]!.resized, [[123, 45]])
  const previousMainMessages = harness.windowFor().messages.length
  harness.spawns[0]!.emitData('during move\r\n')
  assert.equal(harness.windowFor().messages.length, previousMainMessages)
  assert.ok(window.messages.some(message => message.channel === 'desktop:tab-output' && message.payload.data.includes('during move')))
  assert.match(await harness.requestIn(id, 'desktop:get-tab-backlog', id), /before move[\s\S]*during move/)
  const replay = await harness.requestIn(id, 'desktop:get-tab-snapshot', id)
  const output = window.messages.find(message => message.channel === 'desktop:tab-output')!
  assert.equal(replay.sequence, output.payload.sequence)
  assert.match(replay.data, /during move/)
  await harness.request('desktop:rename-tab', id, 'Renamed pop-out')
  assert.match(window.title, /Renamed pop-out/)
  window.close()
  assert.deepEqual((await harness.request('desktop:get-state')).poppedOutTabIds, [])
  assert.equal(harness.spawns.length, 1)
  assert.equal(harness.spawns[0]!.stopped, false)
  await harness.request('desktop:write-tab', id, 'back in main')
  assert.deepEqual(harness.spawns[0]!.written, ['popout input', 'back in main'])
  await harness.request('desktop:pop-out-tab', id)
  const quitCalls = harness.quitCalls()
  harness.windowFor().close()
  assert.equal(harness.quitCalls(), quitCalls + 1, 'closing main with auxiliary windows still requests app quit')
}))

test('multiple pop-outs isolate input and survive sibling close, restart, and renderer crash', async () => fixture(async (harness, directory) => {
  const profile = createWorkspaceProfile(directory)
  harness.configure({ ...structuredClone(DEFAULT_DESKTOP_CONFIG), notifications: false, profiles: [profile], activeProfileId: profile.id }, EMPTY_COPILOT_CAPABILITIES)
  harness.createTestWindow()
  const first = (await harness.createMain()).activeTabId!
  const second = (await harness.createMain()).activeTabId!
  await harness.request('desktop:pop-out-tab', first)
  await harness.request('desktop:pop-out-tab', second)
  const firstWindow = harness.windowFor(first)
  const secondWindow = harness.windowFor(second)
  await harness.requestIn(first, 'desktop:write-tab', second, 'wrong session')
  assert.deepEqual(harness.spawns[1]!.written, [])
  await harness.requestIn(second, 'desktop:restart-tab', second)
  assert.equal(harness.windowFor(second), secondWindow)
  assert.equal(harness.spawns[1]!.stopped, true)
  assert.equal(harness.spawns[2]!.stopped, false)
  await harness.request('desktop:close-tab', first)
  assert.equal(firstWindow.destroyed, true)
  assert.equal(secondWindow.destroyed, false)
  assert.deepEqual((await harness.request('desktop:get-state')).poppedOutTabIds, [second])
  secondWindow.webContents.emit('render-process-gone')
  assert.deepEqual((await harness.request('desktop:get-state')).poppedOutTabIds, [])
  assert.equal(harness.spawns[2]!.stopped, false)
  await assert.rejects(async () => harness.request('desktop:pop-out-tab', first), /Unknown session/)
  await harness.request('desktop:pop-out-tab', second)
  const beforeQuit = harness.windowFor(second)
  harness.beginQuit()
  beforeQuit.close()
  await harness.flushConfig()
  assert.ok(harness.spawns.every(spawn => spawn.stopped))
  await assert.rejects(async () => harness.request('desktop:pop-out-tab', second), /shutting down/)
}))

test('idle pop-outs retain their title, stay menu-free, and focus on workspace activation', async () => fixture(async (harness, directory) => {
  const first = createWorkspaceProfile(directory)
  const secondPath = join(directory, 'second'); await mkdir(secondPath)
  const second = createWorkspaceProfile(secondPath)
  harness.configure({ ...structuredClone(DEFAULT_DESKTOP_CONFIG), notifications: false, profiles: [first, second], activeProfileId: first.id }, EMPTY_COPILOT_CAPABILITIES)
  harness.createTestWindow()
  harness.refreshAppMenu()
  const firstId = (await harness.createMain()).activeTabId!
  await harness.request('desktop:rename-tab', firstId, 'Idle session title')
  await harness.request('desktop:pop-out-tab', firstId)
  const popout = harness.windowFor(firstId)
  // Flush the mocked page load, which applies the HTML title unless prevented.
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(popout.title, 'Idle session title — Copilot CLI Desktop')
  assert.equal(popout.menu, null)
  harness.refreshAppMenu()
  assert.ok(harness.windowFor().menu)
  assert.equal(popout.menu, null, 'global menu rebuilding must not restore pop-out accelerators')
  await harness.request('desktop:create-tab', null, second.id)
  const previousFocus = popout.focused
  const switched = await harness.request('desktop:activate-profile', first.id)
  assert.equal(popout.focused, previousFocus + 1)
  assert.equal(switched.activeProfileId, first.id)
  assert.equal(switched.activeTabId, firstId)
  assert.equal(popout.menu, null)
  assert.equal(harness.spawns.length, 2)
  assert.ok(harness.spawns.every(spawn => !spawn.stopped))
}))

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
  assert.deepEqual(harness.shellCalls, [{ action: 'reveal', target: zip }])
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
    await harness.waitForQuit()
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
  await harness.waitForQuit()
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
  await harness.waitForQuit()
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

test('browser profile identity persists with restored tabs, CLI restarts, and legacy tabs', async () => fixture(async (harness, directory) => {
  const { profile } = configure(harness, directory)
  profile.tabs = [
    { title: 'Remembered', lastSessionId: SOURCE, browserProfileId: SOURCE },
    { title: 'Duplicate', lastSessionId: FORK, browserProfileId: SOURCE },
    { title: 'Legacy', lastSessionId: null },
  ]
  await harness.restore()
  const opened = await harness.request('desktop:get-state')
  assert.equal(opened.tabs[0]!.browserProfileId, SOURCE)
  assert.equal(new Set(opened.tabs.map(tab => tab.browserProfileId)).size, 3)
  assert.ok(opened.tabs.every(tab => typeof tab.browserProfileId === 'string'))
  harness.createTestWindow()
  await harness.request('desktop:browser-open', opened.tabs[0]!.id)
  assert.equal(harness.browserConfigs[0]!.settings, join(directory, 'browser-profiles', SOURCE, 'settings.json'))
  assert.equal(harness.browserConfigs[0]!.options.partition, `persist:browser-debug:${SOURCE}`)
  assert.notEqual(harness.browserConfigs[0]!.options.endpointPath, harness.browserConfigs[0]!.settings)
  const restarted = await harness.request('desktop:restart-tab', opened.tabs[0]!.id)
  assert.deepEqual(restarted.tabs.map(tab => tab.browserProfileId), opened.tabs.map(tab => tab.browserProfileId))
  await harness.flushConfig()
  const saved = JSON.parse(await readFile(join(directory, 'desktop.json'), 'utf8')) as DesktopConfig
  assert.deepEqual(saved.profiles[0]!.tabs.map(tab => tab.browserProfileId), opened.tabs.map(tab => tab.browserProfileId))
}))

test('explicit close removes profile settings and helper files even when browser disposal rejects', async () => fixture(async (harness, directory) => {
  configure(harness, directory)
  harness.createTestWindow()
  const opened = await harness.createMain()
  const tab = opened.tabs[0]!
  const profile = join(directory, 'browser-profiles', tab.browserProfileId!)
  await mkdir(profile, { recursive: true })
  await writeFile(join(profile, 'settings.json'), 'saved-page')
  await harness.request('desktop:browser-open', tab.id)
  const helper = harness.spawns[0]!.env.COPILOT_DESKTOP_BROWSER_HELPER!
  await access(helper)
  let rejectDispose!: (error: Error) => void
  harness.blockBrowserDispose(new Promise<void>((_accept, reject) => { rejectDispose = reject }), () => rejectDispose(new Error('flush failed')))
  const closed = await harness.request('desktop:close-tab', tab.id)
  assert.equal(closed.tabs.length, 0)
  await assert.rejects(access(profile))
  await assert.rejects(access(helper))
  assert.deepEqual(harness.browserStorageClears.map(entry => entry.operation), ['closeAllConnections', 'clearData', 'clearCache', 'clearAuthCache'])
  assert.ok(harness.browserStorageClears.every(entry => entry.partition === `persist:browser-debug:${tab.browserProfileId}`))
  await assert.rejects(async () => harness.request('desktop:browser-state', tab.id), /Unknown browser session/)
  await harness.flushConfig()
  const saved = JSON.parse(await readFile(join(directory, 'desktop.json'), 'utf8')) as DesktopConfig
  assert.deepEqual(saved.profiles[0]!.tabs, [])
}))

test('failed capability detection reports a retryable error before launching a configured model', async () => {
  await fixture(async (harness, directory) => {
    const { profile, capabilities } = configure(harness, directory)
    profile.launch.model = 'gpt-5.3-codex'
    capabilities.probeFailed = true
    await assert.rejects(harness.createMain(), /Could not determine Copilot CLI capabilities.*Retry CLI detection from Settings/)
    assert.equal(harness.spawns.length, 0)
  })
})

test('a successful probe without --model retains the unsupported-option error', async () => {
  await fixture(async (harness, directory) => {
    const { profile } = configure(harness, directory)
    profile.launch.model = 'gpt-5.3-codex'
    await assert.rejects(harness.createMain(), /This Copilot CLI version does not support --model/)
    assert.equal(harness.spawns.length, 0)
  })
})

test('failed capability detection does not stop a running session during restart', async () => {
  await fixture(async (harness, directory) => {
    const { profile, capabilities } = configure(harness, directory)
    const opened = await harness.createMain()
    profile.launch.model = 'gpt-5.3-codex'
    capabilities.probeFailed = true
    await assert.rejects(harness.request('desktop:restart-tab', opened.activeTabId), /Could not determine Copilot CLI capabilities/)
    assert.equal(harness.spawns.length, 1)
    assert.equal(harness.spawns[0]!.stopped, false)
  })
})

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
    // The pair is on screen, so both start at once, in either order: tell them apart by session.
    const spawnOf = (id: string): string[] => harness.spawns.find((spawn) => spawn.args.some((arg) => arg.endsWith(id)))!.args
    assert.ok(spawnOf(SOURCE).includes('--allow-all'), 'resume preserves the original startup baseline')
    assertRestricted(spawnOf(FORK))
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

test('restoring one workspace preserves saved sessions in other workspaces on disk', async () => fixture(async (harness, directory) => {
  const { profile, capabilities } = configure(harness, directory)
  const secondPath = join(directory, 'second'); await mkdir(secondPath)
  const second = createWorkspaceProfile(secondPath)
  profile.tabs = [{ title: 'First workspace', lastSessionId: SOURCE }]
  second.tabs = [{ title: 'Second workspace', lastSessionId: FORK }]
  harness.configure({ ...structuredClone(DEFAULT_DESKTOP_CONFIG), profiles: [profile, second], activeProfileId: profile.id }, capabilities)

  await harness.restore()
  await harness.flushConfig()
  const saved = JSON.parse(await readFile(join(directory, 'desktop.json'), 'utf8')) as DesktopConfig
  assert.deepEqual(saved.profiles[1]!.tabs.map(tab => tab.lastSessionId), [FORK])
  const state = await harness.request('desktop:activate-profile', second.id)
  assert.ok(state.tabs.some(tab => tab.lastSessionId === FORK))
}))

test('startup lists all saved workspaces, starts only the shown tab, and retains the selected workspace', async () => fixture(async (harness, directory) => {
  const { profile, capabilities } = configure(harness, directory)
  const secondPath = join(directory, 'second'); await mkdir(secondPath)
  const second = createWorkspaceProfile(secondPath)
  const unused = createWorkspaceProfile(join(directory, 'unused'))
  profile.tabs = [{ title: 'First workspace', lastSessionId: SOURCE }]
  second.tabs = [{ title: 'Second workspace', lastSessionId: FORK }]
  // Both sessions are in Copilot's store, so both resume.
  for (const id of [SOURCE, FORK]) { await mkdir(join(directory, 'session-state', id), { recursive: true }); await writeFile(join(directory, 'session-state', id, 'events.jsonl'), '{"type":"session.start"}\n') }
  harness.configure({ ...structuredClone(DEFAULT_DESKTOP_CONFIG), profiles: [profile, second, unused], activeProfileId: profile.id }, capabilities)
  await harness.restoreSaved()
  const state = await harness.request('desktop:get-state')
  assert.deepEqual(state.tabs.map(tab => tab.lastSessionId), [SOURCE, FORK])
  assert.deepEqual(harness.spawns.map(spawn => spawn.cwd), [directory], 'the other workspace tab waits until it is shown')
  assert.ok(harness.spawns[0]!.args.includes(`--resume=${SOURCE}`))
  assert.deepEqual(state.tabs.map(tab => tab.status), ['running', 'dormant'])
  assert.equal(state.activeProfileId, profile.id)
  assert.equal(state.tabs.find(tab => tab.id === state.activeTabId)?.workspaceProfileId, profile.id)
  await harness.flushConfig()
  const saved = JSON.parse(await readFile(join(directory, 'desktop.json'), 'utf8')) as DesktopConfig
  assert.equal(saved.activeProfileId, profile.id)
  assert.deepEqual(saved.profiles.map(entry => entry.tabs.length), [1, 1, 0])
  // Showing it starts it.
  await harness.request('desktop:activate-tab', state.tabs[1]!.id)
  await waitFor(() => harness.spawns.length, (count) => count === 2, 'the shown tab starts')
  assert.equal(harness.spawns[1]!.cwd, secondPath)
  assert.ok(harness.spawns[1]!.args.includes(`--resume=${FORK}`))
  // Explicitly closing a restored tab must still remove it from the next restart.
  await harness.request('desktop:close-tab', state.tabs[1]!.id)
  await harness.flushConfig()
  const closed = JSON.parse(await readFile(join(directory, 'desktop.json'), 'utf8')) as DesktopConfig
  assert.deepEqual(closed.profiles[1]!.tabs, [])
  await harness.request('desktop:activate-profile', second.id)
  assert.equal(harness.spawns.length, 3, 'an explicitly emptied workspace can start a fresh tab')
}))

test('a restored tab that fails to start stays saved, shows as crashed, and starts on restart', async () => fixture(async (harness, directory) => {
  const { profile } = configure(harness, directory)
  profile.tabs = [{ title: 'Not shown', lastSessionId: SOURCE }, { title: 'Temporarily unavailable', lastSessionId: FORK }]
  harness.setNextSpawn(async () => { throw new Error('temporary PTY failure') })
  await harness.restore()
  await harness.flushConfig()
  const saved = JSON.parse(await readFile(join(directory, 'desktop.json'), 'utf8')) as DesktopConfig
  assert.deepEqual(saved.profiles[0]!.tabs.map(tab => tab.lastSessionId), [SOURCE, FORK])
  const failed = await harness.request('desktop:get-state')
  assert.deepEqual(failed.tabs.map(tab => tab.status), ['dormant', 'crashed'], 'a failure is not retried each time the tab is shown')
  assert.equal(harness.spawns.length, 0)
  const restarted = await harness.request('desktop:restart-tab', failed.activeTabId)
  assert.deepEqual(restarted.tabs.map(tab => tab.status), ['dormant', 'running'])
  assert.ok(harness.spawns[0]!.args.some(arg => arg.endsWith(FORK)), harness.spawns[0]!.args.join(' '))
}))

test('saved tabs that are never shown never start, and closing one starts nothing', async () => fixture(async (harness, directory) => {
  const { profile } = configure(harness, directory)
  profile.tabs = [{ title: 'First', lastSessionId: SOURCE }, { title: 'Second', lastSessionId: FORK }, { title: 'Shown', lastSessionId: null }]
  await harness.restore()
  const state = await harness.request('desktop:get-state')
  assert.deepEqual(state.tabs.map(tab => [tab.title, tab.status]), [['First', 'dormant'], ['Second', 'dormant'], ['Shown', 'running']])
  assert.equal(harness.spawns.length, 1)
  await harness.request('desktop:close-tab', state.tabs[0]!.id)
  assert.equal(harness.spawns.length, 1)
  await harness.flushConfig()
  const saved = JSON.parse(await readFile(join(directory, 'desktop.json'), 'utf8')) as DesktopConfig
  assert.deepEqual(saved.profiles[0]!.tabs.map(tab => [tab.title, tab.lastSessionId === FORK]), [['Second', true], ['Shown', false]])
}))

test('unloading a session stops its process and keeps its tab until Resume, which resumes the same conversation', async () => fixture(async (harness, directory) => {
  const { profile } = configure(harness, directory)
  profile.defaultResumeMode = 'new'
  const opened = await harness.createMain()
  const tabId = opened.activeTabId!
  const sessionId = opened.tabs[0]!.lastSessionId!
  await mkdir(join(directory, 'session-state', sessionId), { recursive: true })
  await writeFile(join(directory, 'session-state', sessionId, 'events.jsonl'), '{"type":"session.start"}\n')
  const unloaded = await harness.request('desktop:unload-tab', tabId)
  const tab = unloaded.tabs.find((candidate) => candidate.id === tabId)!
  assert.equal(tab.status, 'dormant')
  assert.equal(tab.unloaded, true)
  assert.equal(tab.processId, null)
  assert.equal(tab.lastSessionId, sessionId)
  assert.equal(harness.spawns[0]!.stopped, true)
  // Shown again, it waits for Resume instead of starting by itself.
  await harness.request('desktop:create-tab', 'new', profile.id)
  await harness.request('desktop:activate-tab', tabId)
  await new Promise((resolve) => setTimeout(resolve, 200))
  assert.equal(harness.spawns.length, 2, 'only the new tab started')
  await harness.flushConfig()
  const saved = JSON.parse(await readFile(join(directory, 'desktop.json'), 'utf8')) as DesktopConfig
  assert.ok(saved.profiles[0]!.tabs.some((entry) => entry.lastSessionId === sessionId), 'an unloaded tab stays saved')
  const resumed = await harness.request('desktop:restart-tab', tabId)
  const after = resumed.tabs.find((candidate) => candidate.id === tabId)!
  assert.equal(after.status, 'running')
  assert.equal(after.unloaded, undefined)
  assert.ok(harness.spawns[2]!.args.includes(`--resume=${sessionId}`), harness.spawns[2]!.args.join(' '))
  // Unloaded twice in a row: the second one has nothing left to stop.
  await harness.request('desktop:unload-tab', tabId)
  await harness.request('desktop:unload-tab', tabId)
  assert.equal(harness.spawns[2]!.stopped, true)
  assert.equal(harness.spawns.length, 3)
}))

test('an unloaded session\'s browser stays closed, also while it unloads, until Resume', async () => fixture(async (harness, directory) => {
  const { profile } = configure(harness, directory)
  profile.defaultResumeMode = 'new'
  const tabId = (await harness.createMain()).activeTabId!
  harness.createTestWindow()
  await harness.request('desktop:browser-open', tabId)
  assert.equal(harness.browserConfigs.length, 1)
  let release!: () => void, disposing!: () => void
  const disposeStarted = new Promise<void>((resolve) => { disposing = resolve })
  harness.blockBrowserDispose(new Promise<void>((resolve) => { release = resolve }), disposing)
  const unloading = harness.request('desktop:unload-tab', tabId)
  await disposeStarted
  // The panel on screen keeps polling its browser's state.
  await assert.rejects(async () => harness.request('desktop:browser-state', tabId), /closing/)
  release()
  await unloading
  await assert.rejects(async () => harness.request('desktop:browser-state', tabId), /unloaded/)
  assert.equal(harness.browserConfigs.length, 1, 'no browser is created while unloading or unloaded')
  await harness.request('desktop:restart-tab', tabId)
  await harness.request('desktop:browser-state', tabId)
  assert.equal(harness.browserConfigs.length, 2, 'Resume makes the browser available again')
}))

test('restoration links a saved side chat even when its parent follows it in the saved list', async () => fixture(async (harness, directory) => {
  const { profile } = configure(harness, directory)
  profile.tabs = [{ title: 'Side', lastSessionId: FORK, sideChat: true, sideParentSessionId: SOURCE }, { title: 'Parent', lastSessionId: SOURCE }]
  await harness.restore()
  const state = await harness.request('desktop:get-state')
  assert.equal(state.tabs.find(tab => tab.sideChat)?.sideParentTabId, state.tabs.find(tab => tab.lastSessionId === SOURCE)?.id)
}))

test('a failed fresh workspace launch never persists a phantom restore candidate', async () => fixture(async (harness, directory) => {
  const { profile } = configure(harness, directory)
  harness.setNextSpawn(async () => { throw new Error('temporary PTY failure') })
  await harness.restore()
  await harness.flushConfig()
  const failed = JSON.parse(await readFile(join(directory, 'desktop.json'), 'utf8')) as DesktopConfig
  assert.deepEqual(failed.profiles[0]!.tabs, [])

  const opened = await harness.request('desktop:create-tab', 'new', profile.id)
  await harness.flushConfig()
  const retried = JSON.parse(await readFile(join(directory, 'desktop.json'), 'utf8')) as DesktopConfig
  assert.deepEqual(retried.profiles[0]!.tabs.map(tab => tab.lastSessionId), [opened.tabs[0]!.lastSessionId])
  await harness.request('desktop:close-tab', opened.activeTabId)
  await harness.flushConfig()
  const closed = JSON.parse(await readFile(join(directory, 'desktop.json'), 'utf8')) as DesktopConfig
  assert.deepEqual(closed.profiles[0]!.tabs, [])
}))

test('manual CLI recheck and update restore only the selected workspace', async () => {
  for (const operation of ['recheck', 'update']) await fixture(async (harness, directory) => {
    const { profile, capabilities } = configure(harness, directory)
    const secondPath = join(directory, 'second'); await mkdir(secondPath)
    const second = createWorkspaceProfile(secondPath)
    second.tabs = [{ title: 'Other workspace', lastSessionId: SOURCE }]
    harness.configure({ ...structuredClone(DEFAULT_DESKTOP_CONFIG), profiles: [profile, second], activeProfileId: profile.id }, capabilities)
    if (operation === 'recheck') await harness.request('desktop:retry-resolution')
    else await harness.maintain('update')
    const state = await harness.request('desktop:get-state')
    assert.equal(state.activeProfileId, profile.id)
    assert.deepEqual(harness.spawns.map(spawn => spawn.cwd), [directory])
    await harness.flushConfig()
    const saved = JSON.parse(await readFile(join(directory, 'desktop.json'), 'utf8')) as DesktopConfig
    assert.deepEqual(saved.profiles[1]!.tabs.map(tab => tab.lastSessionId), [SOURCE])
  })
})

test('restoration preserves the saved order of adjacent parent and side-chat pairs', async () => fixture(async (harness, directory) => {
  const { profile } = configure(harness, directory)
  const secondParent = '33333333-3333-4333-8333-333333333333'
  const secondSide = '44444444-4444-4444-8444-444444444444'
  profile.tabs = [
    { title: 'Parent 1', lastSessionId: SOURCE },
    { title: 'Side 1', lastSessionId: FORK, sideChat: true, sideParentSessionId: SOURCE },
    { title: 'Parent 2', lastSessionId: secondParent },
    { title: 'Side 2', lastSessionId: secondSide, sideChat: true, sideParentSessionId: secondParent },
  ]
  const expected = profile.tabs.map(tab => tab.lastSessionId)
  await harness.restore()
  const state = await harness.request('desktop:get-state')
  assert.deepEqual(state.tabs.map(tab => tab.lastSessionId), expected)
  assert.equal(state.tabs[1]!.sideParentTabId, state.tabs[0]!.id)
  assert.equal(state.tabs[3]!.sideParentTabId, state.tabs[2]!.id)
  await harness.flushConfig()
  const saved = JSON.parse(await readFile(join(directory, 'desktop.json'), 'utf8')) as DesktopConfig
  assert.deepEqual(saved.profiles[0]!.tabs.map(tab => tab.lastSessionId), expected)
}))

test('an empty selected workspace does not replace saved sessions with a new tab at startup', async () => fixture(async (harness, directory) => {
  const { profile, capabilities } = configure(harness, directory)
  const secondPath = join(directory, 'second'); await mkdir(secondPath)
  const second = createWorkspaceProfile(secondPath)
  second.tabs = [{ title: 'Saved', lastSessionId: SOURCE }]
  harness.configure({ ...structuredClone(DEFAULT_DESKTOP_CONFIG), profiles: [profile, second], activeProfileId: profile.id }, capabilities)
  await harness.restoreSaved()
  const state = await harness.request('desktop:get-state')
  assert.deepEqual(state.tabs.map(tab => tab.lastSessionId), [SOURCE])
  assert.equal(state.activeProfileId, second.id)
  assert.equal(harness.spawns.length, 1)
}))

test('saved tabs survive an interruption partway through restoring a workspace', async () => fixture(async (harness, directory) => {
  const { profile } = configure(harness, directory)
  profile.tabs = [{ title: 'First', lastSessionId: SOURCE }, { title: 'Second', lastSessionId: FORK }]
  let release!: () => void, entered!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  harness.setNextSpawn(() => { entered(); return new Promise<void>(resolve => { release = resolve }) })
  const restoring = harness.restore()
  await started
  try {
    await harness.flushConfig()
    const saved = JSON.parse(await readFile(join(directory, 'desktop.json'), 'utf8')) as DesktopConfig
    assert.deepEqual(saved.profiles[0]!.tabs.map(tab => tab.lastSessionId), [SOURCE, FORK])
  } finally { release(); await restoring }
}))

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
    assert.deepEqual(await harness.request('desktop:reveal-path', state.activeTabId, '..\\outside.txt'), { ok: false, reason: 'outside-workspace' })
    assert.deepEqual(harness.shellCalls, [])
  })
})

test('file links reveal existing workspace files and report missing targets', async () => {
  await fixture(async (harness, directory) => {
    configure(harness, directory)
    const state = await harness.createMain()
    const folder = join(directory, 'folder with spaces')
    const file = join(folder, 'example.txt')
    await mkdir(folder)
    await writeFile(file, 'link fixture')
    assert.deepEqual(await harness.request('desktop:reveal-path', state.activeTabId, 'folder with spaces/example.txt'), { ok: true })
    assert.deepEqual(await harness.request('desktop:reveal-path', state.activeTabId, file), { ok: true })
    assert.deepEqual(harness.shellCalls, [
      { action: 'reveal', target: file },
      { action: 'reveal', target: file },
    ])
    assert.deepEqual(await harness.request('desktop:reveal-path', state.activeTabId, 'missing.txt'), { ok: false, reason: 'missing' })
    assert.equal(harness.shellCalls.length, 2, 'missing targets must not launch Explorer')
    await harness.request('desktop:open-external-url', 'https://example.com/')
    assert.deepEqual(harness.shellCalls[2], { action: 'open', target: 'https://example.com/' })
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

test('a fresh worktree launch carries no --session-id, a --name only when named, and adopts the id the CLI writes to the store', async () => {
  await fixture(async (harness, directory) => {
    const { profile } = configure(harness, directory)
    profile.launch = { ...profile.launch, worktree: true }
    profile.defaultResumeMode = 'new'
    harness.configure({ ...DEFAULT_DESKTOP_CONFIG, profiles: [profile], activeProfileId: profile.id }, { ...EMPTY_COPILOT_CAPABILITIES, sessionIdentity: true, toolAllowlist: true,
      supportedOptions: ['--mode', '--agent', '--worktree', '--remote', '--remote-export', '--no-remote', '--no-remote-export'] })
    const opened = await harness.createMain()
    const args = harness.spawns[0]!.args
    const worktreeArg = args.find((arg) => arg.startsWith('--worktree='))
    assert.ok(worktreeArg, args.join(' '))
    const worktreeName = worktreeArg.slice('--worktree='.length)
    assert.match(worktreeName, /^desktop-[a-z0-9-]+-[0-9a-f]{6}$/, 'the desktop names the worktree')
    assert.ok(!args.some((arg) => arg.startsWith('--name=')), 'nobody named the startup session, so Copilot names it')
    assert.equal(opened.tabs[0]?.autoTitle, true)
    assert.ok(!args.some((arg) => arg.startsWith('--session-id=')), 'Copilot refuses --session-id with --worktree')
    assert.ok(!args.some((arg) => arg.startsWith('--resume')), 'a fresh launch does not resume')
    assert.equal(opened.tabs[0]?.lastSessionId, null)

    // The CLI picks the id and writes the session's log under COPILOT_HOME, which the fixture points at `directory`.
    const sessionId = '99999999-9999-4999-8999-999999999999'
    const sessionDirectory = join(directory, 'session-state', sessionId)
    await mkdir(sessionDirectory, { recursive: true })
    await writeFile(join(sessionDirectory, 'events.jsonl'),
      JSON.stringify({ type: 'session.start', data: { sessionId, startTime: new Date().toISOString(), context: { cwd: join(directory, 'project.worktrees', worktreeName) } } }) + '\n'
      + '{"type":"session.permissions_changed","data":{"allowAllPermissionMode":"auto","allowAllPermissions":false}}\n')
    let state = opened
    for (let attempt = 0; attempt < 60 && state.tabs[0]?.lastSessionId !== sessionId; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100))
      state = await harness.request('desktop:get-state')
    }
    assert.equal(state.tabs[0]?.lastSessionId, sessionId, 'the tab learned its id from the store')
    harness.spawns[0]!.emitData('\u001b[?25h')
    for (let attempt = 0; attempt < 30 && state.tabs[0]?.sessionPermissionMode !== 'assisted'; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100))
      state = await harness.request('desktop:get-state')
    }
    assert.equal(state.tabs[0]?.sessionPermissionMode, 'assisted', 'the permission monitor follows the discovered session')
  })
})

/** Copilot keeps a session's name in `<COPILOT_HOME>/session-state/<id>/workspace.yaml`; the fixture's COPILOT_HOME is `directory`. */
async function writeSessionName(directory: string, sessionId: string, name: string): Promise<void> {
  await mkdir(join(directory, 'session-state', sessionId), { recursive: true })
  await writeFile(join(directory, 'session-state', sessionId, 'workspace.yaml'), `id: ${sessionId}\nname: ${name}\nuser_named: false\n`)
}

async function waitFor<T>(read: () => Promise<T> | T, done: (value: T) => boolean, label: string, timeoutMs = 8_000): Promise<T> {
  const end = Date.now() + timeoutMs
  let value = await read()
  while (!done(value)) {
    if (Date.now() > end) throw new Error(`Timed out: ${label} (last: ${JSON.stringify(value)})`)
    await new Promise((resolve) => setTimeout(resolve, 100))
    value = await read()
  }
  return value
}

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

test('an unnamed session starts without --name and its tab takes the name Copilot gives it', async () => {
  await fixture(async (harness, directory) => {
    const { profile } = configure(harness, directory)
    profile.defaultResumeMode = 'new'
    const opened = await harness.createMain()
    const tab = opened.tabs[0]!
    assert.ok(!harness.spawns[0]!.args.some((arg) => arg.startsWith('--name=')), harness.spawns[0]!.args.join(' '))
    assert.ok(harness.spawns[0]!.args.some((arg) => arg.startsWith('--session-id=')))
    assert.equal(tab.title, profile.name, 'the project name shows until Copilot names it')
    assert.equal(tab.autoTitle, true)
    await harness.refreshNames()
    assert.equal((await harness.request('desktop:get-state')).tabs[0]?.title, profile.name, 'no name yet: the tab keeps the project name')
    await writeSessionName(directory, tab.lastSessionId!, 'Say hello please')
    await harness.refreshNames()
    const named = await harness.request('desktop:get-state')
    assert.equal(named.tabs[0]?.title, 'Say hello please', 'the tab took the name Copilot gave the session')
    assert.equal(named.tabs[0]?.autoTitle, true, 'it keeps following that name')
    assert.deepEqual(harness.spawns[0]!.written, [], 'nothing is typed for an unnamed session')
    // A session named in the dialog carries its name.
    await harness.request('desktop:create-tab', null, profile.id, 'Fix login')
    assert.ok(harness.spawns[1]!.args.includes('--name=Fix login'), harness.spawns[1]!.args.join(' '))
    assert.equal((await harness.request('desktop:get-state')).tabs[1]?.autoTitle, false)
  })
})

test('renaming a tab types /rename into an idle session at an empty prompt, and waits while the prompt holds a draft', async () => {
  await fixture(async (harness, directory) => {
    const { profile } = configure(harness, directory)
    profile.defaultResumeMode = 'new'
    const opened = await harness.createMain()
    const id = opened.tabs[0]!.id
    const sessionId = opened.tabs[0]!.lastSessionId!
    await writeSessionName(directory, sessionId, 'Say hello please')
    await harness.refreshNames()
    const spawn = harness.spawns[0]!
    spawn.emitData('> \r\n <- open sidebar | / commands\r\n')

    // A draft in the prompt box: nothing is typed, since the draft would be sent with the command.
    await harness.request('desktop:write-tab', id, 'half a thought')
    await harness.request('desktop:rename-tab', id, 'Fix login race')
    await pause(2_200)
    await harness.refreshNames()
    await pause(400)
    assert.deepEqual(spawn.written, ['half a thought'], 'a draft holds the rename back')
    const renamed = await harness.request('desktop:get-state')
    assert.equal(renamed.tabs[0]?.title, 'Fix login race')
    assert.equal(renamed.tabs[0]?.autoTitle, false, 'the tab no longer follows the Copilot name')

    // Right after Enter the prompt may be starting a turn; once things are quiet the rename goes through.
    await harness.request('desktop:write-tab', id, '\r')
    await harness.refreshNames()
    await pause(400)
    assert.ok(!spawn.written.includes('/rename Fix login race'), 'not right after Enter')
    await pause(2_000)
    await harness.refreshNames()
    await waitFor(() => spawn.written, (written) => written.at(-1) === '\r' && written.includes('/rename Fix login race'), '/rename typed')
    assert.deepEqual(spawn.written.slice(-3), ['\r', '/rename Fix login race', '\r'])
    // Copilot confirms the name; nothing is typed again.
    await writeSessionName(directory, sessionId, 'Fix login race')
    await harness.refreshNames()
    await pause(400)
    assert.equal(spawn.written.filter((data) => data.startsWith('/rename')).length, 1)
  })
})

test('keys pressed while the desktop is typing /rename wait for its Enter, so they never become part of the name', async () => {
  await fixture(async (harness, directory) => {
    const { profile } = configure(harness, directory)
    profile.defaultResumeMode = 'new'
    const opened = await harness.createMain()
    const id = opened.tabs[0]!.id
    await writeSessionName(directory, opened.tabs[0]!.lastSessionId!, 'Say hello please')
    await harness.refreshNames()
    const spawn = harness.spawns[0]!
    spawn.emitData(' <- open sidebar | / commands\r\n')
    await pause(2_200)
    await harness.request('desktop:rename-tab', id, 'Race rename')
    await waitFor(() => spawn.written, (written) => written.includes('/rename Race rename'), '/rename typed')
    // The command is on screen and its Enter has not been pressed yet: someone starts typing.
    await harness.request('desktop:write-tab', id, ' UNSENT_DRAFT')
    assert.deepEqual(spawn.written, ['/rename Race rename'], 'held back while the command is being typed')
    await waitFor(() => spawn.written, (written) => written.length === 3, 'held keys passed on')
    assert.deepEqual(spawn.written, ['/rename Race rename', '\r', ' UNSENT_DRAFT'], 'the rename is sent alone, the keys land in the next prompt')
    // Those keys are now a draft in the prompt box: nothing more is typed over them.
    await harness.request('desktop:rename-tab', id, 'Second rename')
    await pause(2_200)
    await harness.refreshNames()
    await pause(400)
    assert.deepEqual(spawn.written, ['/rename Race rename', '\r', ' UNSENT_DRAFT'])
  })
})

test('closing a tab whose rename is still waiting clears the draft and renames the session before it stops', async () => {
  await fixture(async (harness, directory) => {
    const { profile } = configure(harness, directory)
    profile.defaultResumeMode = 'new'
    const opened = await harness.createMain()
    const id = opened.tabs[0]!.id
    const sessionId = opened.tabs[0]!.lastSessionId!
    await writeSessionName(directory, sessionId, 'Say hello please')
    await harness.refreshNames()
    const spawn = harness.spawns[0]!
    spawn.emitData(' <- open sidebar | / commands\r\n')
    await harness.request('desktop:write-tab', id, 'unsent draft')
    await harness.request('desktop:rename-tab', id, 'Keep this name')
    const closing = harness.request('desktop:close-tab', id)
    await waitFor(() => spawn.written, (written) => written.includes('/rename Keep this name'), '/rename typed on close')
    assert.deepEqual(spawn.written.slice(0, 3), ['unsent draft', '\x03', '/rename Keep this name'], 'Ctrl+C clears the draft first')
    assert.equal(spawn.stopped, false, 'the session is still running while it renames')
    await writeSessionName(directory, sessionId, 'Keep this name')
    await closing
    assert.equal(spawn.stopped, true)
  })
})

test('a saved tab whose session Copilot never stored starts fresh under the same id instead of failing to resume', async () => fixture(async (harness, directory) => {
  const { profile, capabilities } = configure(harness, directory)
  // Opened without a name and closed before its first prompt: Copilot never stored it.
  profile.tabs = [{ title: profile.name, lastSessionId: SOURCE, autoTitle: true }]
  harness.configure({ ...structuredClone(DEFAULT_DESKTOP_CONFIG), profiles: [profile], activeProfileId: profile.id }, capabilities)
  await harness.restoreSaved()
  const args = harness.spawns[0]!.args
  assert.ok(!args.some((arg) => arg.startsWith('--resume')), args.join(' '))
  assert.ok(args.includes(`--session-id=${SOURCE}`), 'the tab keeps its id')
  assert.ok(!args.some((arg) => arg.startsWith('--name=')), 'still unnamed')
  assert.equal((await harness.request('desktop:get-state')).tabs[0]?.lastSessionId, SOURCE)
  // Once stored, a restart resumes it.
  await mkdir(join(directory, 'session-state', SOURCE), { recursive: true })
  await writeFile(join(directory, 'session-state', SOURCE, 'events.jsonl'), '{"type":"session.start"}\n')
  await harness.request('desktop:restart-tab', (await harness.request('desktop:get-state')).tabs[0]!.id)
  assert.ok(harness.spawns[1]!.args.includes(`--resume=${SOURCE}`), harness.spawns[1]!.args.join(' '))
}))

test('a new session can choose its own worktree over the project setting, either way, without changing the project', async () => {
  await fixture(async (harness, directory) => {
    const { profile } = configure(harness, directory)
    profile.defaultResumeMode = 'new'
    await harness.createMain()
    assert.ok(!harness.spawns[0]!.args.some((arg) => arg.startsWith('--worktree')), 'the project does not use worktrees')
    await harness.request('desktop:create-tab', null, profile.id, 'In a worktree', { worktree: true })
    const worktreeArg = harness.spawns[1]!.args.find((arg) => arg.startsWith('--worktree='))
    assert.match(worktreeArg ?? '', /^--worktree=desktop-in-a-worktree-[0-9a-f]{6}$/, harness.spawns[1]!.args.join(' '))
    assert.ok(!harness.spawns[1]!.args.some((arg) => arg.startsWith('--session-id=')), 'Copilot refuses --session-id with --worktree')
    assert.equal(profile.launch.worktree, false, 'the project setting is unchanged')
    // The other way round: a worktree project, one session in the project folder.
    profile.launch = { ...profile.launch, worktree: true }
    await harness.request('desktop:create-tab', null, profile.id, 'In the folder', { worktree: false })
    assert.ok(!harness.spawns[2]!.args.some((arg) => arg.startsWith('--worktree')), harness.spawns[2]!.args.join(' '))
    assert.ok(harness.spawns[2]!.args.some((arg) => arg.startsWith('--session-id=')))
    await harness.request('desktop:create-tab', null, profile.id, 'Project default')
    assert.ok(harness.spawns[3]!.args.some((arg) => arg.startsWith('--worktree=')), 'no choice: the project setting applies')
    await assert.rejects(async () => harness.request('desktop:create-tab', null, profile.id, 'Bad', { worktree: 'yes' }), /Invalid session options/)
  })
})

test('a session keeps its own worktree choice when it restarts before Copilot stored it', async () => {
  await fixture(async (harness, directory) => {
    const { profile } = configure(harness, directory)
    profile.defaultResumeMode = 'new'
    await harness.createMain()
    const latest = async () => (await harness.request('desktop:get-state')).tabs.at(-1)!
    // A normal project, one session in a worktree: Copilot has not stored it yet, so a restart starts it fresh.
    await harness.request('desktop:create-tab', null, profile.id, 'In a worktree', { worktree: true })
    const chosen = await latest()
    assert.equal(chosen.launchWorktree, true)
    await harness.request('desktop:restart-tab', chosen.id)
    assert.ok(harness.spawns.at(-1)!.args.some((arg) => arg.startsWith('--worktree=')), `restart keeps the worktree: ${harness.spawns.at(-1)!.args.join(' ')}`)
    // A worktree project, one session in the project folder.
    profile.launch = { ...profile.launch, worktree: true }
    await harness.request('desktop:create-tab', null, profile.id, 'In the folder', { worktree: false })
    const folder = await latest()
    assert.equal(folder.launchWorktree, false)
    await harness.request('desktop:restart-tab', folder.id)
    assert.ok(!harness.spawns.at(-1)!.args.some((arg) => arg.startsWith('--worktree')), `restart stays in the folder: ${harness.spawns.at(-1)!.args.join(' ')}`)
    assert.equal(profile.launch.worktree, true, 'the project setting is unchanged')
    // Saved and restored: the tab starts as it first did.
    await harness.flushConfig()
    const saved = JSON.parse(await readFile(join(directory, 'desktop.json'), 'utf8')) as DesktopConfig
    const savedTabs = saved.profiles[0]!.tabs
    assert.deepEqual(savedTabs.filter((tab) => tab.title === 'In the folder').map((tab) => tab.launchWorktree), [false])
  })
})

test('a restored tab Copilot never stored starts the way it first started, worktree or not', async () => fixture(async (harness, directory) => {
  const { profile, capabilities } = configure(harness, directory)
  profile.defaultResumeMode = 'new'
  profile.launch = { ...profile.launch, worktree: true }
  profile.tabs = [{ title: 'In the folder', lastSessionId: null, launchWorktree: false }]
  harness.configure({ ...structuredClone(DEFAULT_DESKTOP_CONFIG), profiles: [profile], activeProfileId: profile.id }, capabilities)
  await harness.restoreSaved()
  assert.ok(!harness.spawns[0]!.args.some((arg) => arg.startsWith('--worktree')), `restore stays in the folder: ${harness.spawns[0]!.args.join(' ')}`)
  assert.equal((await harness.request('desktop:get-state')).tabs[0]?.launchWorktree, false)
}))

/** A linked worktree of the repository at `directory`, made of the files git would write (no git needed). Canonical path. */
async function linkedWorktree(directory: string, name: string, branch: string): Promise<string> {
  const gitDir = join(directory, '.git', 'worktrees', name)
  const root = join(directory, name)
  await mkdir(gitDir, { recursive: true })
  await mkdir(root, { recursive: true })
  await writeFile(join(root, '.git'), `gitdir: ${gitDir}\n`)
  await writeFile(join(gitDir, 'gitdir'), `${join(root, '.git')}\n`)
  await writeFile(join(gitDir, 'commondir'), '../..\n')
  await writeFile(join(gitDir, 'HEAD'), `ref: refs/heads/${branch}\n`)
  return realPathNative(root)
}

const sameFolderText = (left: string, right: string): boolean => left.replace(/[\\/]+$/, '').toLowerCase() === right.replace(/[\\/]+$/, '').toLowerCase()

test('a new session can start in an existing worktree of the project, and restarts and restores there', async () => {
  await fixture(async (harness, directory) => {
    const { profile } = configure(harness, directory)
    profile.defaultResumeMode = 'new'
    // Even in a project whose sessions get a new worktree, an existing one is never combined with --worktree.
    profile.launch = { ...profile.launch, worktree: true }
    const feature = await linkedWorktree(directory, 'feature', 'feature/login')
    await harness.createMain()
    const listed = await harness.request('desktop:list-session-worktrees', profile.id) as { path: string; name: string; branch: string | null }[]
    assert.deepEqual(listed.map((entry) => [entry.path.toLowerCase(), entry.name, entry.branch]), [[feature.toLowerCase(), 'feature', 'feature/login']])
    await harness.request('desktop:create-tab', null, profile.id, 'On the feature', { worktreePath: feature })
    const started = harness.spawns.at(-1)!
    assert.ok(sameFolderText(started.cwd, feature), `runs in the worktree: ${started.cwd}`)
    assert.ok(!started.args.some((arg) => arg.startsWith('--worktree')), started.args.join(' '))
    assert.ok(started.args.some((arg) => arg.startsWith('--session-id=')), 'an ordinary fresh session, with its own id')
    const tab = (await harness.request('desktop:get-state')).tabs.at(-1)!
    assert.ok(sameFolderText(tab.launchWorktreePath ?? '', feature))
    assert.equal(tab.launchWorktree, false)
    assert.equal(profile.launch.worktree, true, 'the project setting is unchanged')
    await harness.request('desktop:restart-tab', tab.id)
    assert.ok(sameFolderText(harness.spawns.at(-1)!.cwd, feature), 'a restart runs there again')
    await harness.flushConfig()
    const saved = JSON.parse(await readFile(join(directory, 'desktop.json'), 'utf8')) as DesktopConfig
    assert.ok(sameFolderText(saved.profiles[0]!.tabs.find((entry) => entry.title === 'On the feature')?.launchWorktreePath ?? '', feature))
    // Only a listed linked worktree is accepted: not the main checkout, not some other folder, not with a new worktree too.
    await assert.rejects(async () => harness.request('desktop:create-tab', null, profile.id, 'Main', { worktreePath: directory }), /no longer a worktree/)
    await mkdir(join(directory, 'plain'))
    await assert.rejects(async () => harness.request('desktop:create-tab', null, profile.id, 'Plain', { worktreePath: join(directory, 'plain') }), /no longer a worktree/)
    await assert.rejects(async () => harness.request('desktop:create-tab', null, profile.id, 'Both', { worktree: true, worktreePath: feature }), /Invalid session options/)
  })
})

test('a chosen worktree stays valid when more worktrees than the start-in list shows are added later', async () => {
  await fixture(async (harness, directory) => {
    const { profile, capabilities } = configure(harness, directory)
    profile.defaultResumeMode = 'new'
    const chosen = await linkedWorktree(directory, 'zz-chosen', 'chosen')
    await harness.createMain()
    await harness.request('desktop:create-tab', null, profile.id, 'Chosen', { worktreePath: chosen })
    for (let index = 0; index < 50; index++) await linkedWorktree(directory, `aa-${String(index).padStart(2, '0')}`, `branch-${index}`)
    const listed = await harness.request('desktop:list-session-worktrees', profile.id) as { path: string }[]
    assert.equal(listed.length, 50)
    assert.ok(!listed.some((entry) => sameFolderText(entry.path, chosen)), 'the chosen worktree is past the list cap now')
    const tab = (await harness.request('desktop:get-state')).tabs.at(-1)!
    await harness.request('desktop:restart-tab', tab.id)
    assert.ok(sameFolderText(harness.spawns.at(-1)!.cwd, chosen), `a restart still runs there: ${harness.spawns.at(-1)!.cwd}`)
  })
  await fixture(async (harness, directory) => {
    const { profile, capabilities } = configure(harness, directory)
    profile.defaultResumeMode = 'new'
    const chosen = await linkedWorktree(directory, 'zz-chosen', 'chosen')
    for (let index = 0; index < 50; index++) await linkedWorktree(directory, `aa-${String(index).padStart(2, '0')}`, `branch-${index}`)
    profile.tabs = [{ title: 'Chosen', lastSessionId: null, launchWorktree: false, launchWorktreePath: chosen }]
    harness.configure({ ...structuredClone(DEFAULT_DESKTOP_CONFIG), profiles: [profile], activeProfileId: profile.id }, capabilities)
    await harness.restoreSaved()
    assert.ok(sameFolderText(harness.spawns[0]!.cwd, chosen), `a restore still runs there: ${harness.spawns[0]!.cwd}`)
  })
})

test('a restored tab starts in its existing worktree, or in the project folder once that worktree is gone', async () => fixture(async (harness, directory) => {
  const { profile, capabilities } = configure(harness, directory)
  profile.defaultResumeMode = 'new'
  const feature = await linkedWorktree(directory, 'feature', 'feature')
  const gone = await linkedWorktree(directory, 'gone', 'gone')
  await rm(join(directory, '.git', 'worktrees', 'gone'), { recursive: true })
  profile.tabs = [
    { title: 'Feature', lastSessionId: null, launchWorktree: false, launchWorktreePath: feature },
    { title: 'Gone', lastSessionId: null, launchWorktree: false, launchWorktreePath: gone },
  ]
  harness.configure({ ...structuredClone(DEFAULT_DESKTOP_CONFIG), profiles: [profile], activeProfileId: profile.id }, capabilities)
  await harness.restoreSaved()
  // The last saved tab is shown, so it starts first; the other starts when it is shown.
  assert.ok(sameFolderText(harness.spawns[0]!.cwd, directory), `a worktree that is gone falls back to the project: ${harness.spawns[0]!.cwd}`)
  const featureTab = (await harness.request('desktop:get-state')).tabs.find((tab) => tab.title === 'Feature')!
  await harness.request('desktop:activate-tab', featureTab.id)
  await waitFor(() => harness.spawns.length, (count) => count === 2, 'the shown tab starts')
  assert.ok(sameFolderText(harness.spawns[1]!.cwd, feature), harness.spawns[1]!.cwd)
  const tabs = (await harness.request('desktop:get-state')).tabs
  assert.equal(tabs.find((tab) => tab.title === 'Gone')?.launchWorktreePath, undefined)
}))

test('a session can keep Local Overrides to itself: its browser runs DevTools in its own partition, out of the shared settings', async () => {
  await fixture(async (harness, directory) => {
    const { profile, capabilities } = configure(harness, directory)
    profile.defaultResumeMode = 'new'
    const opened = await harness.createMain()
    harness.createTestWindow()
    assert.equal(opened.newSessionPrivateOverrides, false, 'shared by default')
    assert.equal(opened.tabs[0]!.privateOverrides, undefined)
    // Chosen in the new-session dialog.
    await harness.request('desktop:create-tab', null, profile.id, 'Own overrides', { sharedOverrides: false })
    const own = (await harness.request('desktop:get-state')).tabs.at(-1)!
    assert.equal(own.privateOverrides, true)
    await harness.request('desktop:browser-open', opened.tabs[0]!.id)
    await harness.request('desktop:browser-open', own.id)
    assert.equal(harness.browserConfigs[0]!.options.devtoolsPartition, undefined, 'the shared one uses the default session')
    assert.equal(harness.browserConfigs[1]!.options.devtoolsPartition, `persist:browser-devtools:${own.browserProfileId}`)
    const store = JSON.parse(await readFile(join(directory, 'browser-devtools.json'), 'utf8'))
    assert.deepEqual(store.private, [own.browserProfileId], 'its page partition stays out of the shared DevTools settings')
    // The Settings default applies to sessions started without a choice, and only to new ones.
    harness.configure({ ...DEFAULT_DESKTOP_CONFIG, profiles: [profile], activeProfileId: profile.id, browserOverrides: 'private' }, capabilities)
    const after = await harness.request('desktop:get-state')
    assert.equal(after.newSessionPrivateOverrides, true)
    assert.equal(after.tabs[0]!.privateOverrides, undefined, 'an open session keeps what it started with')
    await harness.request('desktop:create-tab', null, profile.id, 'Default now private')
    assert.equal((await harness.request('desktop:get-state')).tabs.at(-1)!.privateOverrides, true)
    await harness.request('desktop:create-tab', null, profile.id, 'Shared anyway', { sharedOverrides: true })
    assert.equal((await harness.request('desktop:get-state')).tabs.at(-1)!.privateOverrides, undefined)
    // Saved with the tab.
    await harness.flushConfig()
    const saved = JSON.parse(await readFile(join(directory, 'desktop.json'), 'utf8')) as DesktopConfig
    assert.equal(saved.browserOverrides, 'private')
    assert.deepEqual(saved.profiles[0]!.tabs.map((tab) => tab.privateOverrides === true), [false, true, true, false])
  })
})

test('a fan-out starts sessions one after another in their own worktrees, each only after the previous one reported its folder', async () => {
  await fixture(async (harness, directory) => {
    const previousWait = process.env.DESKTOP_FAN_OUT_WAIT_MS
    process.env.DESKTOP_FAN_OUT_WAIT_MS = '3000'
    try {
      const { profile } = configure(harness, directory)
      profile.defaultResumeMode = 'new'
      harness.configure({ ...DEFAULT_DESKTOP_CONFIG, profiles: [profile], activeProfileId: profile.id }, { ...EMPTY_COPILOT_CAPABILITIES, sessionIdentity: true, toolAllowlist: true,
        supportedOptions: ['--mode', '--agent', '--worktree', '--remote', '--remote-export', '--no-remote', '--no-remote-export'] })
      await harness.createMain()
      const before = harness.spawns.length
      // The CLI writes each session's log with its folder; the fan-out waits for that before the next spawn.
      const report = async (index: number): Promise<string> => {
        const spawn = harness.spawns[before + index]!
        const name = spawn.args.find((arg) => arg.startsWith('--worktree='))!.slice('--worktree='.length)
        const sessionId = `${String(index + 1).repeat(8)}-${String(index + 1).repeat(4)}-4${String(index + 1).repeat(3)}-8${String(index + 1).repeat(3)}-${String(index + 1).repeat(12)}`
        const sessionDirectory = join(directory, 'session-state', sessionId)
        await mkdir(sessionDirectory, { recursive: true })
        await writeFile(join(sessionDirectory, 'events.jsonl'), JSON.stringify({ type: 'session.start', data: { sessionId, startTime: new Date().toISOString(), context: { cwd: join(directory, 'project.worktrees', name) } } }) + '\n')
        return name
      }
      const fanOut = harness.request('desktop:fan-out', profile.id, 'fan-out · fix login', 3) as Promise<{ tabIds: string[]; requested: number; stopped: string | null; label: string }>
      for (let attempt = 0; attempt < 50 && harness.spawns.length < before + 1; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 50))
      assert.equal(harness.spawns.length, before + 1, 'only the first session has started')
      await new Promise((resolve) => setTimeout(resolve, 600))
      assert.equal(harness.spawns.length, before + 1, 'the second waits for the first to report its folder')
      const first = await report(0)
      for (let attempt = 0; attempt < 100 && harness.spawns.length < before + 2; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 50))
      assert.equal(harness.spawns.length, before + 2, 'the second started once the first reported')
      const second = await report(1)
      for (let attempt = 0; attempt < 100 && harness.spawns.length < before + 3; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 50))
      assert.equal(harness.spawns.length, before + 3)
      const third = await report(2)
      const result = await fanOut
      assert.equal(result.stopped, null, result.stopped ?? '')
      assert.equal(result.tabIds.length, 3)
      assert.equal(result.requested, 3)
      assert.equal(new Set([first, second, third]).size, 3, 'three distinct worktree names')
      for (const spawn of harness.spawns.slice(before)) {
        assert.ok(spawn.args.some((arg) => arg.startsWith('--worktree=desktop-')), spawn.args.join(' '))
        assert.ok(!spawn.args.some((arg) => arg.startsWith('--session-id=')))
        assert.ok(!spawn.args.some((arg) => arg.includes('fix login')), 'the task is never passed on the command line')
      }
      const state = await harness.request('desktop:get-state')
      const started = state.tabs.filter((tab) => result.tabIds.includes(tab.id))
      assert.deepEqual(started.map((tab) => tab.fanOutLabel), ['fan-out · fix login', 'fan-out · fix login', 'fan-out · fix login'])
      assert.deepEqual(started.map((tab) => tab.title), ['desktop-lifecycle-unit 1/3', 'desktop-lifecycle-unit 2/3', 'desktop-lifecycle-unit 3/3'].map((title) => title.replace('desktop-lifecycle-unit', profile.name)))
      assert.ok(started.every((tab) => tab.sessionCwd), 'every session reported its folder')
    } finally {
      if (previousWait === undefined) delete process.env.DESKTOP_FAN_OUT_WAIT_MS
      else process.env.DESKTOP_FAN_OUT_WAIT_MS = previousWait
    }
  })
})

test('a fan-out stops, and says so, when a session does not report its folder in time; bad requests start nothing', async () => {
  await fixture(async (harness, directory) => {
    const previousWait = process.env.DESKTOP_FAN_OUT_WAIT_MS
    process.env.DESKTOP_FAN_OUT_WAIT_MS = '700'
    try {
      const { profile } = configure(harness, directory)
      profile.defaultResumeMode = 'new'
      harness.configure({ ...DEFAULT_DESKTOP_CONFIG, profiles: [profile], activeProfileId: profile.id }, { ...EMPTY_COPILOT_CAPABILITIES, sessionIdentity: true, toolAllowlist: true,
        supportedOptions: ['--mode', '--agent', '--worktree', '--remote', '--remote-export', '--no-remote', '--no-remote-export'] })
      await harness.createMain()
      const before = harness.spawns.length
      await assert.rejects(async () => harness.request('desktop:fan-out', profile.id, 'task', 1), /2 to 5 sessions/)
      await assert.rejects(async () => harness.request('desktop:fan-out', profile.id, 'task', 6), /2 to 5 sessions/)
      await assert.rejects(async () => harness.request('desktop:fan-out', profile.id, '', 2), /Invalid fan-out label/)
      await assert.rejects(async () => harness.request('desktop:fan-out', profile.id, 'task', 20), /2 to 5 sessions/)
      assert.equal(harness.spawns.length, before, 'nothing started')
      const result = await (harness.request('desktop:fan-out', profile.id, 'fan-out · slow', 2) as Promise<{ tabIds: string[]; stopped: string | null }>)
      assert.equal(harness.spawns.length, before + 1, 'the second was never started blind')
      assert.equal(result.tabIds.length, 1)
      assert.match(result.stopped ?? '', /Session 1 of 2 did not report where it runs/)
      const state = await harness.request('desktop:get-state')
      assert.equal(state.tabs.find((tab) => tab.id === result.tabIds[0])?.fanOutLabel, 'fan-out · slow')
    } finally {
      if (previousWait === undefined) delete process.env.DESKTOP_FAN_OUT_WAIT_MS
      else process.env.DESKTOP_FAN_OUT_WAIT_MS = previousWait
    }
  })
})

test('a fan-out labels and waits on exactly the tabs it created, even when an ordinary tab is created at the same time', async () => {
  await fixture(async (harness, directory) => {
    const previousWait = process.env.DESKTOP_FAN_OUT_WAIT_MS
    process.env.DESKTOP_FAN_OUT_WAIT_MS = '3000'
    try {
      const { profile } = configure(harness, directory)
      profile.defaultResumeMode = 'new'
      harness.configure({ ...DEFAULT_DESKTOP_CONFIG, profiles: [profile], activeProfileId: profile.id }, { ...EMPTY_COPILOT_CAPABILITIES, sessionIdentity: true, toolAllowlist: true,
        supportedOptions: ['--mode', '--agent', '--worktree', '--remote', '--remote-export', '--no-remote', '--no-remote-export'] })
      await harness.createMain()
      const before = harness.spawns.length
      // Only the fan-out's worktree launch waits on its spawn plan; an ordinary New session, started while it waits,
      // registers first. A member chosen as "the first tab not seen before" would be that ordinary tab.
      const known = new Set((await harness.request('desktop:get-state')).tabs.map((tab) => tab.id))
      let release!: () => void
      harness.blockSpawnPlanWhen((candidate) => candidate.launch.worktree === true, new Promise<void>((resolve) => { release = resolve }))
      const fanOut = harness.request('desktop:fan-out', profile.id, 'fan-out · exact', 2) as Promise<{ tabIds: string[]; stopped: string | null }>
      await new Promise((resolve) => setTimeout(resolve, 50))
      const ordinaryState = await (harness.request('desktop:create-tab', 'new', profile.id) as Promise<DesktopState>)
      const ordinaryTab = ordinaryState.tabs.find((tab) => !known.has(tab.id))!
      assert.ok(ordinaryTab && !ordinaryTab.title.includes('/'), 'the ordinary tab registered while the fan-out member was still being prepared')
      release()
      // The fan-out's spawns carry worktree names; report a folder for each as the CLI would.
      const report = async (spawnIndex: number, digit: string): Promise<void> => {
        for (let attempt = 0; attempt < 100 && harness.spawns.length <= spawnIndex; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 50))
        const spawn = harness.spawns[spawnIndex]!
        const name = spawn.args.find((arg) => arg.startsWith('--worktree='))!.slice('--worktree='.length)
        const sessionId = `${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}`
        await mkdir(join(directory, 'session-state', sessionId), { recursive: true })
        await writeFile(join(directory, 'session-state', sessionId, 'events.jsonl'), JSON.stringify({ type: 'session.start', data: { sessionId, startTime: new Date().toISOString(), context: { cwd: join(directory, 'project.worktrees', name) } } }) + '\n')
      }
      const fanOutSpawns = () => harness.spawns.map((spawn, index) => [spawn, index] as const).filter(([spawn, index]) => index >= before && spawn.args.some((arg) => arg.startsWith('--worktree=')))
      for (let attempt = 0; attempt < 100 && fanOutSpawns().length < 1; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 50))
      await report(fanOutSpawns()[0]![1], '5')
      for (let attempt = 0; attempt < 100 && fanOutSpawns().length < 2; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 50))
      await report(fanOutSpawns()[1]![1], '6')
      const result = await fanOut
      assert.equal(result.stopped, null, result.stopped ?? '')
      assert.equal(result.tabIds.length, 2)
      assert.ok(!result.tabIds.includes(ordinaryTab.id), 'the ordinary tab is not a member')
      const state = await harness.request('desktop:get-state')
      assert.equal(state.tabs.find((tab) => tab.id === ordinaryTab.id)?.fanOutLabel ?? null, null, 'the ordinary tab carries no label')
      const members = state.tabs.filter((tab) => result.tabIds.includes(tab.id))
      assert.deepEqual(members.map((tab) => [tab.title, tab.fanOutLabel]), [[`${profile.name} 1/2`, 'fan-out · exact'], [`${profile.name} 2/2`, 'fan-out · exact']])
      assert.ok(members.every((tab) => tab.sessionCwd), 'both members reported their folders')
    } finally {
      if (previousWait === undefined) delete process.env.DESKTOP_FAN_OUT_WAIT_MS
      else process.env.DESKTOP_FAN_OUT_WAIT_MS = previousWait
    }
  })
})

/**
 * A worktree session as the desktop starts one, with real git: the project folder holds a repository, the CLI is told
 * `--worktree=<name>`, and the worktree it would make is made here, at `<repo>.worktrees\<name>`, before the session
 * reports running there.
 */
async function startWorktreeSession(harness: Harness, directory: string, git: string): Promise<{ tabId: string; repo: string; worktree: string; name: string }> {
  const { execFileSync } = await import('node:child_process')
  const globalConfig = join(directory, 'gitconfig')
  writeFileSync(globalConfig, '[user]\n\tname = Test\n\temail = test@example.com\n[init]\n\tdefaultBranch = main\n')
  const env = { ...process.env, GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_NOSYSTEM: '1' }
  const plain = (cwd: string, ...args: string[]): string => execFileSync(git, args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  const repo = join(directory, 'project')
  await mkdir(repo, { recursive: true })
  if (!(await access(join(repo, '.git')).then(() => true, () => false))) {
    plain(repo, 'init', '-q')
    writeFileSync(join(repo, 'a.txt'), 'one\n')
    plain(repo, 'add', '.')
    plain(repo, 'commit', '-q', '-m', 'init')
  }
  const before = harness.spawns.length
  const opened = await harness.request('desktop:create-tab', 'new', (await harness.request('desktop:get-state')).activeProfileId, 'Fix it', { worktree: true }) as DesktopState
  const tabId = opened.activeTabId!
  const name = harness.spawns[before]!.args.find((arg) => arg.startsWith('--worktree='))!.slice('--worktree='.length)
  const worktree = join(`${repo}.worktrees`, name)
  plain(repo, 'worktree', 'add', '-q', '-b', name, worktree, 'HEAD')
  const sessionId = randomSessionId()
  await mkdir(join(directory, 'session-state', sessionId), { recursive: true })
  await writeFile(join(directory, 'session-state', sessionId, 'events.jsonl'),
    JSON.stringify({ type: 'session.start', data: { sessionId, startTime: new Date().toISOString(), context: { cwd: worktree } } }) + '\n')
  await waitFor(async () => (await harness.request('desktop:get-state')).tabs.find((tab) => tab.id === tabId)?.worktree?.name, (value) => value === name, 'the tab shows its worktree')
  return { tabId, repo, worktree, name }
}

function randomSessionId(): string {
  const hex = [...crypto.getRandomValues(new Uint8Array(16))].map((byte) => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

test('a worktree a dormant tab resumes in is kept even while its saved folder is still being read', async (t) => {
  const git = await findGitForTests()
  if (!git) return t.skip('Git unavailable')
  await fixture(async (harness, directory) => {
    const { profile, capabilities } = configure(harness, directory)
    profile.defaultResumeMode = 'new'
    const savedId = randomSessionId()
    profile.tabs = [{ title: 'Saved there', lastSessionId: savedId }, { title: 'Shown', lastSessionId: null }]
    harness.configure({ ...DEFAULT_DESKTOP_CONFIG, trayEnabled: false, profiles: [profile], activeProfileId: profile.id }, capabilities)
    harness.createTestWindow()
    let releaseReads!: () => void
    harness.blockDormantFolderReads(new Promise<void>((resolve) => { releaseReads = resolve }))
    await harness.restore()
    const shared = await startWorktreeSession(harness, directory, git.path)
    // The saved session started in that worktree; the dormant tab has not read so yet.
    await mkdir(join(directory, 'session-state', savedId), { recursive: true })
    await writeFile(join(directory, 'session-state', savedId, 'events.jsonl'),
      JSON.stringify({ type: 'session.start', data: { sessionId: savedId, startTime: new Date().toISOString(), context: { cwd: shared.worktree } } }) + '\n')
    const asked = harness.answerMessageBoxes(0)
    await harness.request('desktop:close-tab', shared.tabId)
    // Without waiting for the read, the cleanup would finish here and remove the worktree.
    await Promise.race([harness.worktreeCleanups(), new Promise((resolve) => setTimeout(resolve, 1_000))])
    releaseReads()
    await harness.worktreeCleanups()
    assert.equal(asked.length, 0)
    assert.equal(await access(shared.worktree).then(() => true, () => false), true, 'the dormant tab resumes there')
    const dormant = (await harness.request('desktop:get-state')).tabs.find((tab) => tab.title === 'Saved there')!
    assert.equal(dormant.status, 'dormant')
    assert.equal(dormant.worktree?.name, shared.name)
  })
})

test('closing a worktree session removes its worktree and branch when nothing is lost, and asks before discarding changes', async (t) => {
  const git = await findGitForTests()
  if (!git) return t.skip('Git unavailable')
  await fixture(async (harness, directory) => {
    const { profile, capabilities } = configure(harness, directory)
    profile.defaultResumeMode = 'new'
    harness.configure({ ...DEFAULT_DESKTOP_CONFIG, trayEnabled: false, profiles: [profile], activeProfileId: profile.id }, capabilities)
    harness.createTestWindow()
    await harness.createMain()
    const exists = (path: string): Promise<boolean> => access(path).then(() => true, () => false)
    const { execFileSync } = await import('node:child_process')
    const branches = (repo: string): string[] => execFileSync(git.path, ['branch', '--format=%(refname:short)'], { cwd: repo, encoding: 'utf8' }).split('\n').filter(Boolean)

    // Clean: removed without a prompt, branch and all.
    const asked = harness.answerMessageBoxes(1)
    const clean = await startWorktreeSession(harness, directory, git.path)
    await harness.request('desktop:close-tab', clean.tabId)
    await harness.worktreeCleanups()
    assert.equal(asked.length, 0, 'nothing to lose, nothing asked')
    assert.equal(await exists(clean.worktree), false)
    assert.ok(!branches(clean.repo).includes(clean.name))

    // Changes: asked; keeping leaves everything as it was.
    const dirty = await startWorktreeSession(harness, directory, git.path)
    writeFileSync(join(dirty.worktree, 'notes.txt'), 'unsaved\n')
    await harness.request('desktop:close-tab', dirty.tabId)
    await harness.worktreeCleanups()
    assert.equal(asked.length, 1)
    assert.match(asked[0]!.detail, /1 uncommitted change/)
    assert.equal(await exists(join(dirty.worktree, 'notes.txt')), true)
    assert.ok(branches(dirty.repo).includes(dirty.name))

    // Changes, confirmed: the folder goes to the Recycle Bin and git forgets it.
    const confirmed = await startWorktreeSession(harness, directory, git.path)
    writeFileSync(join(confirmed.worktree, 'notes.txt'), 'unsaved\n')
    let accepted = harness.answerMessageBoxes(0)
    await harness.request('desktop:close-tab', confirmed.tabId)
    await harness.worktreeCleanups()
    assert.equal(accepted.length, 1)
    assert.ok(harness.shellCalls.some((call) => call.action === 'trash' && call.target.toLowerCase() === confirmed.worktree.toLowerCase()))
    assert.equal(await exists(confirmed.worktree), false)
    assert.ok(!execFileSync(git.path, ['worktree', 'list', '--porcelain'], { cwd: confirmed.repo, encoding: 'utf8' }).includes(confirmed.name))

    // Locked while the confirmation was open: kept, folder, registration and branch.
    const lockedLate = await startWorktreeSession(harness, directory, git.path)
    writeFileSync(join(lockedLate.worktree, 'notes.txt'), 'unsaved\n')
    const trashesBefore = harness.shellCalls.filter((call) => call.action === 'trash').length
    const lockedAsked = harness.answerMessageBoxes(0, () => {
      execFileSync(git.path, ['worktree', 'lock', lockedLate.worktree], { cwd: lockedLate.repo })
    })
    await harness.request('desktop:close-tab', lockedLate.tabId)
    await harness.worktreeCleanups()
    assert.equal(lockedAsked.length, 1)
    assert.equal(harness.shellCalls.filter((call) => call.action === 'trash').length, trashesBefore, 'a locked worktree is never trashed')
    assert.equal(await exists(join(lockedLate.worktree, 'notes.txt')), true)
    assert.ok(branches(lockedLate.repo).includes(lockedLate.name))
    accepted = harness.answerMessageBoxes(0)

    // Another open tab runs there: kept, without asking.
    const shared = await startWorktreeSession(harness, directory, git.path)
    const other = (await harness.request('desktop:create-tab', 'new', profile.id, 'Also there')) as DesktopState
    const otherId = harness.spawns.at(-1)!.args.find((arg) => arg.startsWith('--session-id='))!.slice('--session-id='.length)
    await mkdir(join(directory, 'session-state', otherId), { recursive: true })
    await writeFile(join(directory, 'session-state', otherId, 'events.jsonl'),
      JSON.stringify({ type: 'session.start', data: { sessionId: otherId, startTime: new Date().toISOString(), context: { cwd: shared.worktree } } }) + '\n')
    await waitFor(async () => (await harness.request('desktop:get-state')).tabs.find((tab) => tab.id === other.activeTabId)?.sessionCwd, Boolean, 'the other tab reports its folder')
    const before = accepted.length
    await harness.request('desktop:close-tab', shared.tabId)
    await harness.worktreeCleanups()
    assert.equal(accepted.length, before)
    assert.equal(await exists(shared.worktree), true, 'still in use by another tab')

    // Keep: never touched.
    await harness.requestSettings('desktop-settings:update-preferences', { worktreeCleanup: 'keep' })
    await assert.rejects(harness.requestSettings('desktop-settings:update-preferences', { worktreeCleanup: 'always' }), /Invalid desktop preferences/)
    const kept = await startWorktreeSession(harness, directory, git.path)
    await harness.request('desktop:close-tab', kept.tabId)
    await harness.worktreeCleanups()
    assert.equal(await exists(kept.worktree), true)
  })
})

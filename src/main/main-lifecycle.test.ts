import assert from 'node:assert/strict'
import { access, appendFile, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'
import { build } from 'esbuild'
import { createWorkspaceProfile, DEFAULT_DESKTOP_CONFIG, type DesktopConfig } from './desktop-config.js'
import { EMPTY_COPILOT_CAPABILITIES, type CopilotCapabilities } from './copilot-command.js'
import type { DesktopState, SessionHistoryEntry, WorkspaceProfile } from './types.js'
import { MigrationService } from './migration-service.js'
import { readMigrationArchive, writeMigrationArchive } from './migration-archive.js'
import { fileEntry } from './migration-inventory.js'
import { MigrationImportFailure } from './migration-import.js'
import { realPathNative } from './real-path.js'
import { findGitForTests } from './fixtures/git-fixture.js'
import type { MeetingCommand, MeetingResponse } from './meeting-session.js'
import type { SessionBindingReader } from './session-binding.js'

/** Migration is Windows to Windows only; on other platforms the app does not offer it. */
const migrationOnly = { skip: process.platform === 'win32' ? false : 'migration is Windows only' }
const SOURCE = '11111111-1111-4111-8111-111111111111'
const FORK = '22222222-2222-4222-8222-222222222222'
interface Harness {
  shellCalls: { action: string; target: string }[]
  createTestWindow(): void
  startTestDesktopControl(): Promise<void>
  flushToolPersistence(): Promise<boolean>
  /** Answer every native message box with this button, and collect what each one asked. */
  answerMessageBoxes(response: number, beforeAnswer?: () => void): { title: string; message: string; detail: string; buttons: string[] }[]
  /** Settles once every worktree cleanup started by a tab close has finished. */
  worktreeCleanups(): Promise<void>
  refreshAppMenu(): void
  /** The folder path a File tab is watched for, or null. */
  watchedFile(id: string): string | null
  /** Make the next Settings page loads fail, or succeed again. */
  failSettingsLoad(fail: boolean): void
  settingsWindow(): { destroyed: boolean } | null
  /** Which window the system reports as focused: the main one, or none. */
  focusMainWindow(focused: boolean): void
  quitCalls(): number
  windowFor(tabId?: string): { destroyed: boolean; focused: number; title: string; menu: unknown; messages: { channel: string; payload: any }[]; loads: number; close(): void; emit(name: string): void; webContents: { emit(name: string, ...args: unknown[]): void } }
  /** Wait for every application log line written so far. */
  flushAppLog(): Promise<void>
  requestIn(tabId: string, name: string, ...args: unknown[]): Promise<any>
  configureMigration(busy: boolean, exclusive: boolean): void
  configureMigrationExport(service: MigrationService, path: string, senderDestroyed?: boolean): void
  configureBrowserExportDialog(result: { canceled: boolean; filePath?: string }): void
  blockSpawnPlan(work: Promise<void>): void
  /** Report a change of a tab's activity line, as its session does when a tool starts or finishes. */
  activityChanged(tabId: string): void
  /** How many times the whole state is sent to the windows from here on. */
  countBroadcasts(): { count: number }
  /** Keep the usage flush that comes before a CLI install or update waiting until `work` settles. */
  holdUsageFlush(work: Promise<void>): void
  /** Keep the next CLI install or update command running until `work` settles. */
  holdMaintenance(work: Promise<void>): void
  /** Run the startup settings save with every save failing; resolves with what was written to the app log. */
  startupSaveWithFailingDisk(): Promise<string[]>
  /** The folder the next "choose a workspace" dialog answers with. */
  chooseFolder(path: string): void
  /** The projects whose tools were cleaned up, as they happen. */
  watchProjectRemovals(): string[]
  /** How many times the browser state of a tool tab is copied from here on. */
  countBrowserSnapshots(resource: string): { count: number }
  /** What the next capability recheck finds, in place of asking a real CLI. Returns how many rechecks ran. */
  recheckFinds(capabilities: CopilotCapabilities): { count: number }
  blockSessionStop(tabId:string,work:Promise<void>,started:()=>void):void
  /** Like blockSpawnPlan, but only plans for a profile the predicate accepts wait; the others run at once. */
  blockSpawnPlanWhen(accept: (profile: WorkspaceProfile) => boolean, work: Promise<void>): void
  /** Dormant tabs' reads of their saved session's folder wait for `work`. */
  blockDormantFolderReads(work: Promise<void>): void
  /** Linked-worktree lookups finish, call `started`, then wait for `work` before returning. */
  blockWorktreeLookups(work: Promise<void>, started: () => void): void
  setNextSpawn(work: () => Promise<void>): void
  flushConfig(): Promise<void>
  checkMigrationIdle(): void
  configure(config: DesktopConfig, capabilities: CopilotCapabilities): void
  createMain(): Promise<DesktopState>
  enableTasks(tabId: string,supported?:boolean): void
  captureWorkflowNotifications():{title:string;body:string}[]
  flushWorkflowNotifications():void
  seedWorkflowHistory(count:number):void
  workflowBroadcastReads(active:boolean):number
  automaticPaste(tabId:string,authorized:()=>boolean): {result:string}
  launchInvestigation(projectId:string,head:string,authorized:()=>boolean):Promise<{sessionId:string;taskId:string}>
  interruptOwnedTurn(tabId:string,foreign:boolean):void
  meetingWrite(meetingId:string,path:string,text:string):Promise<boolean>
  holdMeetingWrite(predicate:(path:string)=>boolean,work:()=>Promise<void>,started?:()=>void):void
  flushMeetingWrites(meetingId:string):Promise<void>
  queueLegacyMeeting(tabId:string):void
  queueRejectedMeeting(tabId:string):void
  deferTaskEnter():void
  flushTaskEnter():void
  composedPaste(tabId:string):{result:string}
  composedCommand(tabId:string):boolean
  makeBindingUnreadable(tabId:string):void
  corruptHandoff(tabId:string,corrupt?:boolean):void
  followupReadyFor(tabId:string):boolean
  meetingCommand(tabId: string, command: MeetingCommand, sessionId?: string, text?: string): Promise<MeetingResponse>
  configureBinding(tabId: string, rootPid: number, ownedPids: number[]): void
  bindingReader(tabId: string): Pick<SessionBindingReader, 'read'>
  refreshRecords(tabId: string): Promise<void>
  queueMeetingDelivery(tabId: string, kind: 'post' | 'add-dir',text?:string): void
  pumpMeetingDelivery(): Promise<void>
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
  spawns: { args: string[]; cwd: string; env: NodeJS.ProcessEnv; cols: number; rows: number; worktreeTimeoutMinutes?: number; stopped: boolean; written: string[]; resized: number[][]; emitData(data: string): void; emitExit(): void }[]
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
          constructor(owner, settings, options) { this.options=options; browserConfigs.push({ settings, options }); }
          pages = [{id:12,title:"Browser",url:""}];
          get pageCount(){return this.pages.length;}
          pageList(){return this.pages;}
          openerOf(){return null;}
          hasPage(id){return this.pages.some(p=>p.id===id);}
          selectUiPage(id){this.snapshot.activePageId=id;}
          createPage(){const id=this.pages.length+12;this.pages.push({id,title:"Browser",url:""});return id;}
          async closePage(id){this.pages=this.pages.filter(p=>p.id!==id);this.options.changed?.();return true;}
          snapshot = { activePageId:12, url: '', console: [], network: [] };
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
          destroyed = false; focused = 0; title = ''; messages = []; loads = 0;
          constructor(options = {}) { super(); this.title = options.title || ''; allWindows.push(this); }
          static focusedWindow = null; static failLoad = null;
          static getFocusedWindow() { return this.focusedWindow; }
          static fromWebContents(contents) { return allWindows.find(window => window.webContents === contents && !window.destroyed) || null; }
          webContents = Object.assign(new EventEmitter(), {
            getURL: () => this.url || '',
            send: (channel, payload) => this.messages.push({ channel, payload }),
            setWindowOpenHandler() {},
            session: { setPermissionCheckHandler() {}, setPermissionRequestHandler() {} },
          });
          setMenu(menu) { this.menu = menu; } setTitle(title) { this.title = title; }
          isDestroyed() { return this.destroyed; } isMinimized() { return false; } isFocused() { return false; } isVisible() { return true; }
          show() {} focus() { this.focused++; this.emit('focus'); } restore() {} flashFrame() {}
          async loadFile(path) {
            if (BrowserWindow.failLoad?.(path)) throw new Error('page load failed');
            this.loads++;
            this.url = (await import('node:url')).pathToFileURL(path).href;
            let prevented = false;
            this.emit('page-title-updated', { preventDefault() { prevented = true; } }, 'Copilot CLI Desktop');
            if (!prevented) this.title = 'Copilot CLI Desktop';
          }
          close() { this.destroy(); }
          destroy() { if (!this.destroyed) { this.destroyed = true; this.emit('closed'); } }
        };
        export const clipboard = {}, dialog = {}, globalShortcut = { isRegistered: () => false }, nativeImage = {}, safeStorage = {}, Tray = {};
        export class Notification extends EventEmitter { static enabled=false;static shown=[];static isSupported(){return this.enabled} constructor(options){super();this.options=options}show(){Notification.shown.push(this.options)} }
        // Desktop control starts only on Windows and is exercised by its own tests and desktop-control-check.mjs.
        export const powerMonitor = { on() {} }, screen = { on() {}, off() {} }, desktopCapturer = {};
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
      // The real launch and MCP config checks cover Antigravity without touching this harness's user settings.
      './antigravity-mcp.js': 'export async function configureAntigravityMeetingMcp() {}',
      './copilot-maintenance.js': `
        export const maintenanceCalls = [];
        export const DEFAULT_COPILOT_MAINTENANCE_STATE = { status: 'idle', operation: null, message: '' };
        let held = null;
        export function holdCopilotCommand(work) { held = work; }
        export async function installCopilotCli() { maintenanceCalls.push('install'); const work = held; held = null; await work; return ''; }
        export async function updateCopilotCli() { maintenanceCalls.push('update'); const work = held; held = null; await work; return ''; }
      `,
      './node-pty-backend.js': `
        export const spawns = [];
        let nextSpawn;
        export function setNextSpawn(work) { nextSpawn = work; }
        export async function spawnNodePty(file, args, options) {
          const work = nextSpawn; nextSpawn = null; if (work) await work();
          const exits = new Set();
          const dataListeners = new Set();
          const record = { args, cwd: options.cwd, env: options.env, cols: options.cols, rows: options.rows, worktreeTimeoutMinutes: options.worktreeTimeoutMinutes, stopped: false, written: [], resized: [], emitExit() { for (const fn of exits) fn({exitCode:0}); }, emitData(data) { for (const fn of dataListeners) fn(data); } };
          spawns.push(record);
          return { pid: undefined, onData(fn) { dataListeners.add(fn); }, onExit(fn) { exits.add(fn); }, write(data) { record.written.push(data); }, resize(cols, rows) { record.resized.push([cols, rows]); },
            kill() { record.stopped = true; for (const fn of exits) fn({ exitCode: 0 }); } };
        }
      `,
      // The real module, with linked-worktree lookups a test can hold after they resolve.
      './git-discovery.js': `
        import * as real from ${JSON.stringify(join(dirname(mainPath), 'git-discovery.js'))};
        export * from ${JSON.stringify(join(dirname(mainPath), 'git-discovery.js'))};
        let gate = null;
        export function blockWorktreeLookups(work, started) { gate = { work, started }; }
        export async function resolveLinkedWorktree(...args) {
          const result = await real.resolveLinkedWorktree(...args);
          if (gate) { gate.started(); await gate.work; }
          return result;
        }
      `,
      './meeting-session.js': `
        import * as real from ${JSON.stringify(join(dirname(mainPath), 'meeting-session.js'))};
        export * from ${JSON.stringify(join(dirname(mainPath), 'meeting-session.js'))};
        let gate = null;
        export function holdMeetingWrite(predicate, work, started) { gate = { predicate, work, started }; }
        export async function writeMeetingFile(root, meetingId, path, text) {
          if (gate && gate.predicate(path)) {
            const current = gate;
            gate = null;
            current.started?.();
            await current.work();
          }
          return real.writeMeetingFile(root, meetingId, path, text);
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
        // Other CLIs (agent-cli.js) resolve through these; inert here, so no real program is ever looked up or run.
        export const defaultExecFile = async () => { throw new Error('inert'); };
        export async function resolveWindowsCommand() { return { paths: [], error: new Error('inert') }; }
        export async function tryVersion() { return { ok: false, error: new Error('inert') }; }
        export async function unwrapNpmShim() { return null; }
      `,
    }
    const source = await readFile(mainPath, 'utf8')
    assert.ok(source.includes('void withShutdownDeadline(stopAllSessions()'))
    const testSource = source.replace('void withShutdownDeadline(stopAllSessions()', 'quitCleanupForTest = withShutdownDeadline(quitWorkForTest = stopAllSessions()')
    const bundle = await build({
      stdin: { contents: testSource + `
        let quitCleanupForTest, quitWorkForTest, deferredTaskEnter;
        import { spawns, setNextSpawn } from './node-pty-backend.js';
        import { maintenanceCalls, holdCopilotCommand } from './copilot-maintenance.js';
        import { lastBounds, blockBrowserDispose, browserConfigs } from './browser-debug.js';
        import { blockWorktreeLookups } from './git-discovery.js';
        import { holdMeetingWrite } from './meeting-session.js';
        import { browserStorageClears } from 'electron';
        import { SessionBindingReader as BindingReaderForTest } from './session-binding.js';
        const diagnosticWrites = [];
        let settingsSenderDestroyed = false;
        const originalWriteAppLog = writeAppLog;
        writeAppLog = (...args) => { const work = originalWriteAppLog(...args); diagnosticWrites.push(work); return work; };
        export const lifecycleTest = {
          shellCalls: shell.calls,
          watchedFile: (id) => projectTools().watchedFile(id),
          createTestWindow() { mainWindow = createWindow(false); mainWindow.url = shellUrl(); },
          async flushAppLog() { await Promise.allSettled(diagnosticWrites); await appLogWriteQueue; },
          async startTestDesktopControl() {
            await startDesktopControl();
            desktopControl.native.desktopAvailable = async () => true;
            desktopControl.native.foreground = async () => null;
          },
          async flushToolPersistence() { await projectToolService?.writing; return projectToolService?.profileRecoveryRequired; },
          refreshAppMenu: installApplicationMenu,
          failSettingsLoad(fail) { BrowserWindow.failLoad = fail ? path => path.endsWith('settings.html') : null; },
          settingsWindow: () => settingsWindow,
          focusMainWindow(focused) { BrowserWindow.focusedWindow = focused ? mainWindow : null; },
          quitCalls: () => app.quitCalls,
          windowFor: (tabId) => tabId ? sessionWindows.get(tabId) : mainWindow,
          requestIn: (tabId, name, ...args) => ipcMain.invoke(name, { senderFrame: { url: shellUrl() }, sender: sessionWindows.get(tabId).webContents }, ...args),
          configureMigration(busy, exclusive) { migrationService = { busy, exclusive }; },
          configureMigrationExport(service, path, senderDestroyed = false) { migrationService = service; settingsSenderDestroyed = senderDestroyed; dialog.showSaveDialog = async () => ({ canceled: false, filePath: path }); dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }); },
          configureBrowserExportDialog(result) { dialog.showSaveDialog = async (owner) => { if (!owner || owner.isDestroyed()) throw new Error('Missing live export owner'); return result; }; },
          holdMaintenance(work) { usageService.noteSourceChanged ??= () => {}; holdCopilotCommand(work); },
          holdUsageFlush(work) { usageService.noteSourceChanged ??= () => {}; usageService.flush = async () => { await work; }; },
          async startupSaveWithFailingDisk() { const logged = []; const save = persistConfig, log = writeAppLog; persistConfig = async () => { throw new Error('ENOSPC: no space left on device'); }; writeAppLog = async (message) => { logged.push(message); };
            try { await saveSettingsAtStartup(true); await Promise.resolve(); } finally { persistConfig = save; writeAppLog = log; } return logged; },
          chooseFolder(path) { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }); },
          watchProjectRemovals() { const service = projectTools(), original = service.removeProject.bind(service), seen = []; service.removeProject = async (id) => { seen.push(id); return original(id); }; return seen; },
          countBrowserSnapshots(resource) { const browser = projectTools().resource(resource).browser, state = browser.snapshot, calls = { count: 0 }; Object.defineProperty(browser, 'snapshot', { configurable: true, get() { calls.count++; return state; } }); return calls; },
          recheckFinds(capabilities) { const calls = { count: 0 }; recheckCopilotCapabilities = async () => { calls.count++; copilotCapabilities = capabilities; }; return calls; },
          activityChanged(tabId) { managedTabs.get(tabId).session.emit('activity-detail', null); },
          countBroadcasts() { const original = broadcastState, calls = { count: 0 }; broadcastState = (...args) => { calls.count++; return original(...args); }; return calls; },
          blockSpawnPlan(work) { const original = buildSessionSpawnPlan; buildSessionSpawnPlan = async (...args) => { await work; return original(...args); }; },
          blockSessionStop(tabId,work,started) { const session=managedTabs.get(tabId).session; const original=session.stop.bind(session);session.stop=async()=>{started();await work;return original()}; },
          blockSpawnPlanWhen(accept, work) { const original = buildSessionSpawnPlan; buildSessionSpawnPlan = async (...args) => { if (accept(args[0])) await work; return original(...args); }; },
          blockDormantFolderReads(work) { const original = applyDormantSessionCwd; applyDormantSessionCwd = async (...args) => { await work; return original(...args); }; },
          blockWorktreeLookups,
          checkMigrationIdle,
          spawns,
          setNextSpawn,
          flushConfig: () => configWriteQueue,
          maintenanceCalls,
          configure(config, capabilities) { desktopConfig = config; copilotCapabilities = capabilities;
            deliveryJournal??=new WorkflowDeliveries(join(app.getPath('userData'),'workflow-deliveries.sqlite'));
            state.resolution = { kind: 'direct', command: 'inert-pty', prefixArgs: [], resolvedPath: null, version: '1.0.82', error: null, pathAdditions: ['C:/Program Files/nodejs'] }; syncWorkspaceState(); },
          createMain: () => createSessionTab(),
          enableTasks: (tabId,supported=true) => { app.isReady = () => true; tabsState.tabs.find(t => t.id === tabId).cliVersion = supported?'1.0.105':null; workflows();deliveryJournal??=new WorkflowDeliveries(join(app.getPath('userData'),'workflow-deliveries.sqlite')); },
          captureWorkflowNotifications:()=>{Notification.enabled=true;desktopConfig.notifications=true;workflowNotifications.prime(attentionItems());workflowAttentionReady=true;return Notification.shown},
          flushWorkflowNotifications:()=>workflowNotifications.flush(),
          seedWorkflowHistory:count=>{const store=workflows();for(let n=0;n<count;n++){const task=store.submitted('history-'+n,'project','R'.repeat(3800));store.report(task.sessionId,{taskId:task.id,assignmentId:task.assignmentId,scopeRevision:1,outcome:'ready',summary:'S'.repeat(1000)});if(n<Math.floor(count*0.9))store.finish(task.id,'completed')}},
          workflowBroadcastReads:active=>{workflowAttentionReady=active;const store=workflows(),original=store.list;let calls=0;store.list=function(){calls++;return original.call(this)};try{broadcastState()}finally{store.list=original}return calls},
          automaticPaste: (tabId,authorized) => sendSessionTask(tabId,'bounded automatic continuation',true,{
            beforePaste:authorized,beforeEnter:authorized,aborted:()=>meetingReader(tabId).cancelExpectedDesktopPrompt(),
          }),
          launchInvestigation: (projectId,head,authorized) => {
            app.isReady=()=>true;state.resolution.version='1.0.105';refreshCopilotResolutionIfChanged=async()=>{};workflows();deliveryJournal??=new WorkflowDeliveries(join(app.getPath('userData'),'workflow-deliveries.sqlite'));
            const rule={id:randomUUID(),revision:randomUUID(),projectId,repository:'owner/repo',scopeKey:automationScope(projectId)};
            return launchAutomationTask(rule,{key:'github/owner/repo/issue/1',version:'a'.repeat(64),actorId:7,at:Date.now(),title:'Investigate issue',body:'Investigate token=fixture-secret',head,branch:'main'},authorized);
          },
          interruptOwnedTurn: (tabId,foreign) => {
            const tab=tabsState.tabs.find(t=>t.id===tabId),session=managedTabs.get(tabId).session;
            const grant={id:randomUUID(),sessionId:tab.lastSessionId,projectId:tab.workspaceProfileId};
            const delivery=deliveryJournal.enqueue({sessionId:grant.sessionId,source:'github/interrupt',revision:'v1',scope:grant.id,text:'Automatic work'});
            deliveryJournal.begin(delivery.id,()=>true);deliveryJournal.submitted(delivery.id);
            const current=foreign?'${FORK}':grant.sessionId;
            tabsState=setTabSessionId(tabsState,tabId,current);session.lastKnownSessionId=current;session.bindingState={kind:'bound',sessionId:current,deliveryReady:true};
            const timer=setTimeout(()=>{},100000);timer.unref();automaticTurns.set(tabId,{deliveryId:delivery.id,grant,session,timer,stopping:false,authorized:()=>false});
            interruptAutomatic(grant);endAutomatic(tabId,false);
          },
          meetingWrite: async(id,path,text)=>{meetingHub.effects.write(id,path,text);await meetingWrites.get(id);return meetingWriteFailures.has(id)},
          holdMeetingWrite,
          flushMeetingWrites: async id => { await meetingWrites.get(id) },
          composedPaste: tabId=>sendSessionTask(tabId,'Person-composed task'),
          composedCommand: tabId=>sendSessionCommand(tabId,'/add-dir example'),
          makeBindingUnreadable: tabId=>{managedTabs.get(tabId).session.bindingReader.read=async()=>{throw new Error('Temporary inventory failure')}},
          corruptHandoff: (tabId,corrupt=true)=>{
            const sessionId=tabsState.tabs.find(t=>t.id===tabId).lastSessionId;
            const d=deliveryJournal.enqueue({sessionId,source:'fixture/read-failure',revision:'v1',scope:'fixture',text:'Safe body'});
            deliveryJournal.begin(d.id,()=>true);deliveryJournal.submitted(d.id);
            if(corrupt)deliveryJournal.db.prepare('UPDATE deliveries SET body=? WHERE id=?').run('token=fixture-secret',d.id);
          },
          followupReadyFor: tabId=>{app.isReady=()=>true;const tab=tabsState.tabs.find(t=>t.id===tabId),task=workflows().submitted(tab.lastSessionId,tab.workspaceProfileId,'Readiness fixture');return followupReady({taskId:task.id,sessionId:task.sessionId,projectId:task.projectId})},
          meetingCommand: (tabId, command, sessionId, text = 'Test proposal body') => handleMeetingCommand(tabId, command, { topic: 'Test proposal', text, changes: null,
            ...(sessionId === undefined ? {} : { sessionId }) }),
          configureBinding: (tabId, rootPid, pids) => { managedTabs.get(tabId).session.bindingReader = new BindingReaderForTest(
            copilotSessionRoot(process.env), rootPid, async () => new Set(pids), () => true); },
          bindingReader: (tabId) => managedTabs.get(tabId).session.bindingReader,
          refreshRecords: (tabId) => managedTabs.get(tabId).session.refreshSessionRecords(),
          queueMeetingDelivery: (tabId, kind,text='automatic meeting material') => { meetingOutbox.forget(tabId); meetingOutbox.enqueue(tabId, { meetingId: 'TEST', round: 1, kind, text }); },
          queueLegacyMeeting: tabId=>{meetingOutbox.enqueue(tabId,{meetingId:'K7QF',id:randomUUID(),recovered:true,round:1,kind:'post',text:'Legacy outstanding material'})},
          queueRejectedMeeting: tabId=>{meetingOutbox.enqueue(tabId,{meetingId:'K7QF',id:'invalid?delivery',round:1,kind:'post',text:'Invalid intake fixture'})},
          deferTaskEnter:()=>{scheduleTaskEnter=action=>{deferredTaskEnter=action}},
          flushTaskEnter:()=>{const action=deferredTaskEnter;deferredTaskEnter=null;action?.()},
          pumpMeetingDelivery: () => pumpMeetingOutbox(),
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
          async cleanup() { workflowAttentionReady=false;workflowNotifications.close();workflowResources.close();workflowError = 'test cleanup'; for(const run of automaticTurns.values())clearTimeout(run.timer);automaticTurns.clear();automations?.close();automations=null;workflowStore?.close(); workflowStore = null; clearTimeout(updateQuitTimer); await stopAllSessions();await desktopControl?.dispose();await projectToolService?.dispose();deliveryJournal?.close();deliveryJournal=null; clearTimeout(meetingPumpTimer); await Promise.allSettled(meetingWrites.values()); await configWriteQueue; await quitCleanupForTest; await quitWorkForTest; await Promise.allSettled(diagnosticWrites); },
        };
      `, resolveDir: dirname(mainPath), loader: 'js' },
      bundle: true, platform: 'node', format: 'esm', packages: 'external', write: false,
      // The embedded MyTerminal source is CommonJS; keep Node built-in requires
      // working when the lifecycle fixture bundles it into a temporary ESM entry.
      banner: { js: `import { createRequire as createFixtureRequire } from 'node:module'; const require = createFixtureRequire(${JSON.stringify(import.meta.url)});` },
      plugins: [{ name: 'inert-os-boundaries', setup(builder) {
        builder.onResolve({ filter: /^(electron|electron-updater|\.\/(antigravity-mcp|browser-debug|node-pty-backend|resolve-copilot|copilot-maintenance|migration-service|migration-import|migration-writers|git-discovery|meeting-session)\.js)$/ }, (args) => ({ path: args.path, namespace: 'test-boundary' }))
        builder.onLoad({ filter: /.*/, namespace: 'test-boundary' }, (args) => ({ contents: mocks[args.path]!, loader: 'js', resolveDir: dirname(mainPath) }))
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
    // A session log or config write can still land while the folder is removed (ENOTEMPTY on a slow runner): retry.
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}

test('a newly launched CLI can request desktop approval before manual activation', async () => fixture(async (harness, directory) => {
  const { profile, capabilities } = configure(harness, directory)
  harness.configure({ ...DEFAULT_DESKTOP_CONFIG, desktopControl: true, profiles: [profile], activeProfileId: profile.id }, capabilities)
  harness.createTestWindow()
  await harness.startTestDesktopControl()
  const state = await harness.createMain()
  const tabId = state.activeTabId!
  assert.ok(state.desktopControlReadyTabIds?.includes(tabId))
  assert.equal(state.desktopControl?.[tabId]?.enabled, false)
  const endpoint = JSON.parse(await readFile(harness.spawns[0]!.env.COPILOT_DESKTOP_CONTROL_STATE!, 'utf8'))
  const asked = harness.answerMessageBoxes(0)
  const response = await fetch(`http://127.0.0.1:${endpoint.port}/desktop/windows`, {
    method: 'POST', headers: { authorization: `Bearer ${endpoint.token}`, 'content-type': 'application/json' }, body: '{}',
  })
  assert.equal(response.status, 403)
  assert.equal(asked.length, 1)
  assert.ok(asked[0]!.message.includes(state.tabs.find(tab => tab.id === tabId)!.title))
  assert.match(asked[0]!.message, /list open windows/)
  assert.deepEqual(asked[0]!.buttons, ['Deny', 'Allow once', 'Allow for this session'])
}))

test('worktree timeout settings validate and persist, and new sessions and restarts use the latest value', async () => fixture(async (harness, directory) => {
  const { profile } = configure(harness, directory)
  profile.defaultResumeMode = 'new'
  harness.configure({ ...DEFAULT_DESKTOP_CONFIG, trayEnabled: false, profiles: [profile], activeProfileId: profile.id },
    { ...EMPTY_COPILOT_CAPABILITIES, sessionIdentity: true, toolAllowlist: true })
  const first = await harness.createMain()
  assert.equal(harness.spawns[0]!.worktreeTimeoutMinutes, 10)
  for (const value of [0, -1, 1.5, 1441, '25', null]) {
    await assert.rejects(async () => harness.requestSettings('desktop-settings:update-preferences', { worktreeTimeoutMinutes: value }), /Invalid desktop preferences/)
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

test('meeting start reads pending explicit requests after resume and repeated requests in the same tab', async () => fixture(async (harness, directory) => {
  const { profile, capabilities } = configure(harness, directory)
  const line = (type: string, data: object) => JSON.stringify({ type, data }) + '\n'
  const path = join(directory, 'session-state', SOURCE, 'events.jsonl')
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, line('session.start', {}) + line('user.message', { content: 'PRIVATE old meeting request', interactionId: 'old' }))
  profile.tabs = [{ title: 'Resumed', lastSessionId: SOURCE }]
  harness.configure({ ...DEFAULT_DESKTOP_CONFIG, profiles: [profile], activeProfileId: profile.id }, capabilities)
  await harness.restoreSaved()
  const tabId = (await harness.request('desktop:get-state')).activeTabId!
  const history = await harness.meetingCommand(tabId, 'start')
  assert.equal(history.ok, false, 'historical requests never authorize starts')
  assert.match(history.message, /no active user turn observed/)
  const diagnostic = JSON.parse(history.message.split('\nDiagnostics: ')[1]!)
  assert.equal(diagnostic.tabId, tabId)
  assert.equal(diagnostic.monitor.sessionId, SOURCE)
  assert.equal(diagnostic.monitor.logPath, path)
  assert.equal(diagnostic.live, false)
  assert.equal(diagnostic.currentInteractionId, null)
  assert.doesNotMatch(history.message, /PRIVATE/)

  for (const interactionId of ['first', 'again']) {
    // No output notification or timer: the command itself must read the newly appended request.
    await appendFile(path, line('user.message', { content: 'try to start the meeting again', interactionId })
      + line('assistant.turn_start', { turnId: interactionId })
      + line('assistant.message', { interactionId, content: '', toolRequests: [{ id: 'helper' }] })
      + line('assistant.turn_end', { turnId: interactionId }))
    const started = await harness.meetingCommand(tabId, 'start')
    assert.equal(started.ok, true, started.message)
    assert.match(started.message, /Meeting [A-Z0-9]+ is open/)
    await harness.meetingCommand(tabId, 'end')
    await appendFile(path, line('assistant.turn_start', { turnId: 'final' })
      + line('assistant.message', { interactionId, content: 'Done', phase: 'final_answer', toolRequests: [] })
      + line('assistant.turn_end', { turnId: 'final' }))
    const idle = await harness.meetingCommand(tabId, 'start')
    assert.equal(idle.ok, false, 'a completed person turn cannot authorize another meeting')
    assert.match(idle.message, /lastClearedCurrent.*idle.*assistant.turn_end/)
  }

  await appendFile(path, line('user.message', { content: '[meeting K7QF · round 1 · from the desktop]\nPRIVATE prompt', interactionId: 'desktop' }))
  const desktop = await harness.meetingCommand(tabId, 'start')
  assert.equal(desktop.ok, false)
  assert.match(desktop.message, /Desktop-generated turn/)
  assert.doesNotMatch(desktop.message, /PRIVATE/)
}))

test('meeting authorization stays with each session through tab switching and process replacement', async () => fixture(async (harness, directory) => {
  const { profile, capabilities } = configure(harness, directory)
  const line = (type: string, data: object) => JSON.stringify({ type, data }) + '\n'
  for (const id of [SOURCE, FORK]) {
    await mkdir(join(directory, 'session-state', id), { recursive: true })
    await writeFile(join(directory, 'session-state', id, 'events.jsonl'), line('session.start', {}))
  }
  profile.tabs = [{ title: 'First', lastSessionId: SOURCE }, { title: 'Second', lastSessionId: FORK }]
  harness.configure({ ...DEFAULT_DESKTOP_CONFIG, profiles: [profile], activeProfileId: profile.id }, capabilities)
  await harness.restoreSaved()
  const state = await harness.request('desktop:get-state')
  const firstTab = state.tabs.find(tab => tab.id === state.activeTabId)!
  const secondTab = state.tabs.find(tab => tab.id !== state.activeTabId)!
  const first = firstTab.id, second = secondTab.id
  await appendFile(join(directory, 'session-state', firstTab.lastSessionId!, 'events.jsonl'), line('user.message', { content: 'start a meeting', interactionId: 'source' }))
  await harness.refreshRecords(first)
  await harness.request('desktop:activate-tab', second)
  await harness.request('desktop:restart-tab', second)
  assert.equal(harness.spawns.length, 2, 'the selected session resumes')
  assert.equal((await harness.meetingCommand(second, 'start')).ok, false, 'the other tab cannot borrow authorization')
  const targetPath = join(directory, 'session-state', secondTab.lastSessionId!, 'events.jsonl')
  await appendFile(targetPath, line('user.message', { content: 'start a meeting', interactionId: 'target' }))
  assert.equal((await harness.meetingCommand(second, 'start')).ok, true)
  await harness.meetingCommand(second, 'end')
  await harness.request('desktop:restart-tab', second)
  assert.equal((await harness.meetingCommand(second, 'start')).ok, false, 'replacement process cannot inherit a live reader')
  await appendFile(targetPath, line('user.message', { content: 'try to start the meeting again', interactionId: 'resumed' }))
  assert.equal((await harness.meetingCommand(second, 'start')).ok, true)
}))

test('meeting start safely follows A to B to A within the same tab and PTY, including repeated explicit requests', async () => fixture(async (harness, directory) => {
  const { profile } = configure(harness, directory)
  profile.defaultResumeMode = 'new'
  const line = (type: string, data: object) => JSON.stringify({ type, data }) + '\n'
  const path = (id: string) => join(directory, 'session-state', id, 'events.jsonl')
  await mkdir(dirname(path(FORK)), { recursive: true })
  await writeFile(path(FORK), line('session.start', { sessionId: FORK, startTime: '2026-10-29T00:00:00Z' })
    + line('user.message', { content: 'PRIVATE old start request', interactionId: 'history' }))
  const state = await harness.createMain()
  const tab = state.tabs.find(candidate => candidate.id === state.activeTabId)!
  const a = tab.lastSessionId!, b = FORK
  await mkdir(dirname(path(a)), { recursive: true })
  await writeFile(path(a), line('session.start', { sessionId: a, startTime: new Date().toISOString() })
    + line('user.message', { content: 'start a meeting in A', interactionId: 'a1' }))
  await writeFile(join(dirname(path(a)), 'inuse.11.lock'), '')
  harness.configureBinding(tab.id, 10, [10, 11])
  assert.equal((await harness.meetingCommand(tab.id, 'start', a)).ok, true)

  await writeFile(join(dirname(path(b)), 'inuse.11.lock'), '')
  const historical = await harness.meetingCommand(tab.id, 'start', b)
  assert.equal(historical.ok, false)
  assert.match(historical.message, /no active user turn observed/)
  assert.doesNotMatch(historical.message, /PRIVATE/)
  assert.match((await harness.meetingCommand(tab.id, 'status', b)).message, /not bound to an open meeting/, 'A\'s meeting cannot follow the tab into B')
  assert.equal((await harness.request('desktop:get-state')).tabs.find(candidate => candidate.id === tab.id)?.lastSessionId, a, 'a rejected start cannot publish the candidate binding')
  assert.match((await harness.meetingCommand(tab.id, 'status', a)).message, /you are the host/, 'a rejected start cannot close A\'s meeting')
  await appendFile(path(b), line('session.resume', { resumeTime: new Date().toISOString() })
    + line('user.message', { content: '[meeting K7QF · round 1 · from the desktop]\nStart another meeting', interactionId: 'candidate-desktop' })
    + line('session.usage_checkpoint', { totalNanoAiu: 20e9, totalPremiumRequests: 10 }))
  assert.match((await harness.meetingCommand(tab.id, 'start', b)).message, /Desktop-generated/)
  const existing = (await harness.request('desktop:get-state')).meetings?.find(meeting => meeting.hostTabId === tab.id && meeting.stage !== 'closed')
  assert.deepEqual(existing?.cost, { aiCredits: 0, premiumRequests: 0 }, 'candidate B cannot charge usage to A\'s meeting')
  for (const interactionId of ['b1', 'b2']) {
    await appendFile(path(b), line('session.resume', { resumeTime: new Date().toISOString() })
      + line('user.message', { content: 'try to start the meeting again', interactionId }))
    const started = await harness.meetingCommand(tab.id, 'start', b)
    assert.equal(started.ok, true, started.message)
    assert.match(started.message, /Automatic meeting messages are paused/, 'retained sessions cannot receive misdirected terminal input')
    assert.equal((await harness.meetingCommand(tab.id, 'end', a)).ok, false, 'stale background controls cannot close B\'s meeting')
    await harness.meetingCommand(tab.id, 'end', b)
  }
  await appendFile(path(b), line('user.message', { content: '[meeting K7QF · round 1 · from the desktop]\nReview', interactionId: 'desktop' }))
  assert.match((await harness.meetingCommand(tab.id, 'start', b)).message, /Desktop-generated/)
  assert.equal((await harness.meetingCommand(tab.id, 'start', a)).ok, false, 'returning to A does not reuse its old authorization')
  await appendFile(path(a), line('user.message', { content: 'try again in A', interactionId: 'a2' }))
  assert.equal((await harness.meetingCommand(tab.id, 'start', a)).ok, true)
  assert.equal(harness.spawns.length, 1, 'every request used the same underlying PTY')
  assert.equal((await harness.request('desktop:get-state')).tabs.find(candidate => candidate.id === tab.id)?.lastSessionId, a)
  assert.equal((await harness.meetingCommand(tab.id, 'start', '../foreign')).ok, false)
}))

test('a live join after /resume registers the resumed conversation and delivers once it is alone in the same PTY', async () => fixture(async (harness, directory) => {
  const { profile } = configure(harness, directory)
  profile.defaultResumeMode = 'new'
  const line = (type: string, data: object) => JSON.stringify({ type, data }) + '\n'
  const sessionPath = (id: string) => join(directory, 'session-state', id, 'events.jsonl')
  const lockPath = (id: string) => join(dirname(sessionPath(id)), 'inuse.11.lock')
  async function writeSession(id: string, startTime: string, events = ''): Promise<void> {
    await mkdir(dirname(sessionPath(id)), { recursive: true })
    await writeFile(sessionPath(id), line('session.start', { sessionId: id, startTime }) + events)
  }

  const host = await harness.createMain()
  const hostId = host.activeTabId!
  const hostLog = host.tabs.find(tab => tab.id === hostId)!.lastSessionId!
  await writeSession(hostLog, new Date().toISOString(), line('user.message', { content: 'Start a meeting about this plan' }))
  assert.equal((await harness.meetingCommand(hostId, 'start', undefined, 'Review this proposal from the host')).ok, true)
  const meetingId = (await harness.request('desktop:get-state')).meetings![0]!.id
  const prompt = `join meeting ${meetingId} as correctness reviewer`

  await writeSession(FORK, '2026-10-29T00:00:00Z', line('user.message', { content: prompt }))
  const reviewer = await harness.request('desktop:create-tab', 'new', profile.id)
  const tabId = reviewer.activeTabId!
  const original = reviewer.tabs.find(tab => tab.id === tabId)!.lastSessionId!
  const terminal = harness.spawns[1]!
  await writeSession(original, new Date().toISOString())
  await writeFile(lockPath(original), '')
  harness.configureBinding(tabId, 10, [10, 11])
  await harness.refreshRecords(tabId)
  await writeFile(lockPath(FORK), '')
  await appendFile(sessionPath(FORK), line('session.resume', { resumeTime: new Date().toISOString() }))

  const { port, token } = JSON.parse(await readFile(terminal.env.COPILOT_DESKTOP_MEETING_STATE!, 'utf8'))
  async function joinResumedConversation(): Promise<MeetingResponse> {
    const response = await fetch(`http://127.0.0.1:${port}/join`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: FORK }),
    })
    assert.equal(response.status, 200)
    return response.json() as Promise<MeetingResponse>
  }

  assert.equal((await joinResumedConversation()).ok, false, 'an old join request cannot register a reviewer')
  await appendFile(sessionPath(FORK), line('user.message', { content: `[meeting ${meetingId} · round 1 · from the desktop]\n${prompt}` }))
  assert.equal((await joinResumedConversation()).ok, false, 'a Desktop message cannot authorize a join')
  const before = await harness.request('desktop:get-state')
  assert.equal(before.tabs.find(tab => tab.id === tabId)?.lastSessionId, original)
  assert.equal(before.meetings![0]!.participants.length, 0)

  await appendFile(sessionPath(FORK), line('user.message', { content: prompt, interactionId: 'join' }))
  const joined = await joinResumedConversation()
  assert.equal(joined.ok, true, joined.message)
  assert.match(joined.message, /Close the other running conversations/)
  const joinedState = await harness.request('desktop:get-state')
  assert.equal(joinedState.tabs.find(tab => tab.id === tabId)?.lastSessionId, FORK)
  assert.deepEqual(joinedState.meetings![0]!.participants.map(({ tabId, role }) => ({ tabId, role })), [{ tabId, role: 'correctness reviewer' }])
  assert.equal((await joinResumedConversation()).ok, true, 'a repeat confirms the same seat')
  assert.equal((await harness.request('desktop:get-state')).meetings![0]!.participants.length, 1)

  await appendFile(sessionPath(FORK), line('assistant.turn_start', { turnId: 'finish' })
    + line('assistant.message', { interactionId: 'join', content: 'Joined.', phase: 'final_answer', toolRequests: [] })
    + line('assistant.turn_end', { turnId: 'finish' }))
  await harness.refreshRecords(tabId)
  terminal.emitData('\x1b[?2004h> \r\n <- open sidebar | / commands\r\n')
  await pause(1600)
  await harness.pumpMeetingDelivery()
  assert.deepEqual(terminal.written, [], 'the earlier conversation could still receive terminal input')

  await rm(lockPath(original))
  await harness.refreshRecords(tabId)
  await waitFor(async () => {
    await harness.pumpMeetingDelivery()
    return terminal.written
  }, written => written.some(text => text.includes('Review this proposal from the host')), 'meeting material reaches the resumed conversation')
  assert.equal(harness.spawns.length, 2, 'the host and reviewer still use their original PTY processes')
  assert.equal(terminal.stopped, false)
}))

test('an overlapping stale control cannot close the meeting accepted by another retained session', async () => fixture(async (harness, directory) => {
  const { profile } = configure(harness, directory)
  profile.defaultResumeMode = 'new'
  const line = (type: string, data: object) => JSON.stringify({ type, data }) + '\n'
  const path = (id: string) => join(directory, 'session-state', id, 'events.jsonl')
  await mkdir(dirname(path(FORK)), { recursive: true })
  await writeFile(path(FORK), line('session.start', { sessionId: FORK, startTime: '2026-10-29T00:00:00Z' }))
  const state = await harness.createMain()
  const tab = state.tabs.find(candidate => candidate.id === state.activeTabId)!
  const a = tab.lastSessionId!, b = FORK
  await mkdir(dirname(path(a)), { recursive: true })
  await writeFile(path(a), line('session.start', { sessionId: a, startTime: new Date().toISOString() })
    + line('user.message', { content: 'start a meeting in A', interactionId: 'a1' }))
  await writeFile(join(dirname(path(a)), 'inuse.11.lock'), '')
  harness.configureBinding(tab.id, 10, [10, 11])
  assert.equal((await harness.meetingCommand(tab.id, 'start', a)).ok, true)
  await writeFile(join(dirname(path(b)), 'inuse.11.lock'), '')
  await appendFile(path(b), line('session.resume', { resumeTime: new Date().toISOString() })
    + line('user.message', { content: 'start a meeting in B', interactionId: 'b1' }))

  let reached!: () => void, release!: () => void
  const stableBindingRead = new Promise<void>(resolve => { reached = resolve })
  const proceed = new Promise<void>(resolve => { release = resolve })
  const reader = harness.bindingReader(tab.id)
  const read = reader.read.bind(reader)
  let held = false
  reader.read = async (current, requested) => {
    const result = await read(current, requested)
    if (!held && current === b && requested === b) {
      held = true
      reached()
      await proceed
    }
    return result
  }
  try {
    const startingB = harness.meetingCommand(tab.id, 'start', b)
    await stableBindingRead
    // A is still the committed tab session. Queue its end while B's final ownership read is suspended.
    const endingA = harness.meetingCommand(tab.id, 'end', a)
    release()
    const started = await startingB
    assert.equal(started.ok, true, started.message)
    assert.equal((await endingA).ok, false)
    const after = await harness.request('desktop:get-state')
    assert.equal(after.tabs.find(candidate => candidate.id === tab.id)?.lastSessionId, b, 'the rejected control must not restore A')
    const open = after.meetings?.filter(meeting => meeting.hostTabId === tab.id && meeting.stage !== 'closed')
    assert.equal(open?.length, 1, 'B\'s accepted meeting must remain open')
    assert.match(started.message, new RegExp(`Meeting ${open![0]!.id} is open`))
  } finally { release() }
}))

for (const kind of ['post', 'add-dir'] as const) test(`restored meeting ${kind} reaches its initial recipient before the CLI creates an in-use lock`, async () => fixture(async (harness, directory) => {
  const { profile } = configure(harness, directory)
  profile.tabs = [{ title: 'Restored host', lastSessionId: SOURCE }]
  const path = join(directory, 'session-state', SOURCE, 'events.jsonl')
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify({ type: 'session.start', data: { sessionId: SOURCE, startTime: '2026-10-29T00:00:00Z' } }) + '\n')
  await harness.restoreSaved()
  const state = await harness.request('desktop:get-state')
  const tab = state.tabs.find(candidate => candidate.id === state.activeTabId)!
  const spawn = harness.spawns[0]!
  assert.ok(spawn.args.includes(`--resume=${SOURCE}`))
  harness.configureBinding(tab.id, 10, [10, 11])
  await harness.refreshRecords(tab.id)
  await harness.request('desktop:write-tab', tab.id, '\x1b[?1;2c\x1b]11;rgb:0000/0000/0000\x1b\\')
  spawn.emitData('\x1b[?2004h> \r\n <- open sidebar | / commands\r\n')
  await pause(1_600)
  harness.queueMeetingDelivery(tab.id, kind)
  await harness.pumpMeetingDelivery()
  assert.ok(spawn.written.some(text => text.includes('automatic meeting material')), 'initial no-owner recipient takes its first delivery')
  if(kind==='post')assert.equal((await harness.request('desktop:get-state')).workflowDeliveries?.[0]?.state,'submitted','meeting intent is durable before Enter')
  await pause(350)
  assert.equal(spawn.written.at(-1), '\r', 'delivery was submitted')
  assert.equal((await harness.meetingCommand(tab.id, 'start')).ok, false, 'startup delivery cannot authorize creating a meeting')
}))

for (const kind of ['post', 'add-dir'] as const) test(`automatic meeting ${kind} verifies the recipient after a no-hint resume into an existing directory`, async () => fixture(async (harness, directory) => {
  const { profile } = configure(harness, directory)
  profile.defaultResumeMode = 'new'
  const line = (type: string, data: object) => JSON.stringify({ type, data }) + '\n'
  const path = (id: string) => join(directory, 'session-state', id, 'events.jsonl')
  const state = await harness.createMain()
  const tab = state.tabs.find(candidate => candidate.id === state.activeTabId)!
  const a = tab.lastSessionId!, b = FORK
  for (const id of [a, b]) {
    await mkdir(dirname(path(id)), { recursive: true })
    await writeFile(path(id), line('session.start', { sessionId: id, startTime: new Date().toISOString() }))
  }
  await writeFile(join(dirname(path(a)), 'inuse.11.lock'), '')
  harness.configureBinding(tab.id, 10, [10, 11])
  await harness.refreshRecords(tab.id)
  const spawn = harness.spawns[0]!
  spawn.emitData('\x1b[?2004h> \r\n <- open sidebar | / commands\r\n')
  await pause(1_600)
  harness.queueMeetingDelivery(tab.id, kind)
  await harness.pumpMeetingDelivery()
  assert.ok(spawn.written.some(text => text.includes('automatic meeting material')), 'unique recipient takes the delivery')
  await pause(2_400) // Let Enter submit and the prompt draft become quiet again.
  const before = spawn.written.length
  await writeFile(join(dirname(path(b)), 'inuse.11.lock'), '')
  await appendFile(path(b), line('session.resume', { resumeTime: new Date().toISOString() }))
  harness.queueMeetingDelivery(tab.id, kind)
  await harness.pumpMeetingDelivery()
  assert.equal(spawn.written.length, before, 'retaining B blocks automatic terminal input before any helper hint or output')
  assert.equal((await harness.request('desktop:get-state')).tabs.find(candidate => candidate.id === tab.id)?.lastSessionId, a)
}))

test('project browser IPC validates ownership, frames, bounds and closed resources', async () => fixture(async (harness, directory) => {
  const {profile}=configure(harness,directory); harness.createTestWindow();
  const tools=await harness.request<any>('desktop:tools-action',profile.id,{type:'add',kind:'browser'});
  const tab=tools.projects[0].tabs[0].resource;
  await harness.request('desktop:tools-state');
  for (const channel of ['open','state','navigate','action','bounds','export']) {
    await assert.rejects(async () => harness.requestWithFrame(`desktop:browser-${channel}`,'https://untrusted.test'), /untrusted renderer/);
    await assert.rejects(async () => harness.requestSettings(`desktop:browser-${channel}`), /untrusted renderer/);
  }
  await assert.rejects(async () => harness.request('desktop:browser-open','tab-999'), /closed/);
  await harness.request('desktop:browser-bounds',tab,{x:5,y:10,width:500,height:600});
  assert.deepEqual(harness.browserBounds(),{x:5,y:10,width:500,height:600});
  for(const bounds of [{x:-1,y:0,width:1,height:1},{x:0,y:0,width:Infinity,height:1},{x:0,y:0,width:20001,height:1},{},'bad'])
    await assert.rejects(async () => harness.request('desktop:browser-bounds',tab,bounds),/Invalid browser bounds/);
  await assert.rejects(async () => harness.request('desktop:browser-navigate',tab,123),/Invalid browser URL/);
  await assert.rejects(async () => harness.request('desktop:browser-action',tab,{}),/Invalid browser action/);
  const session=(await harness.createMain()).activeTabId!; await harness.request('desktop:pop-out-tab',session);
  await assert.rejects(async () => harness.requestIn(session,'desktop:browser-state',tab),/main window/);
  await harness.request('desktop:tools-action',profile.id,{type:'close',id:tools.projects[0].tabs[0].id});
  await assert.rejects(async () => harness.request('desktop:browser-state',tab),/closed/);
}))


test('captured browser export contains only the selected page and respects cancellation', async () => fixture(async(harness,directory)=>{
  const {profile}=configure(harness,directory);harness.createTestWindow();
  const tools=await harness.request<any>('desktop:tools-action',profile.id,{type:'add',kind:'browser'});
  const tab=tools.projects[0].tabs[0].resource;
  const browser=await harness.request<any>('desktop:browser-open',tab);
  browser.console.push({pageId:12,message:'selected'},{pageId:99,message:'other'});
  const path=join(directory,'browser-log.json');harness.configureBrowserExportDialog({canceled:false,filePath:path});
  await harness.request('desktop:browser-export',tab,'console');
  assert.deepEqual(JSON.parse(await readFile(path,'utf8')),[browser.console[0]]);
  await assert.rejects(async () => harness.request('desktop:browser-export',tab,'../secret'),/Invalid browser export/);
  harness.configureBrowserExportDialog({canceled:true,filePath:path});await harness.request('desktop:browser-export',tab,'network');
  assert.deepEqual(JSON.parse(await readFile(path,'utf8')),[browser.console[0]]);
}))


test('Git task delivery refuses a session that is no longer current', async()=>fixture(async(harness,directory)=>{
  const {profile}=configure(harness,directory);harness.createTestWindow();
  const first=(await harness.createMain()).activeTabId!;
  await harness.createMain();
  const result=await harness.request<any>('desktop:git-resolve',profile.id,'repo-1',first,'Resolve the conflicts');
  assert.equal(result.result,'refused');
  assert.match(result.message,/current session changed/);
  assert.deepEqual(harness.spawns[0]!.written,[]);
}))

test('promoted workspace browser survives session switches, restart and session closure', async()=>fixture(async(harness,directory)=>{
  const {profile}=configure(harness,directory);harness.createTestWindow();
  const first=(await harness.createMain()).activeTabId!;
  const tools=await harness.request<any>('desktop:tools-action',profile.id,{type:'add',kind:'browser'});
  const resource=tools.projects[0].tabs[0].resource;
  await harness.request('desktop:browser-navigate',resource,'https://first.example/');
  await harness.request('desktop:tools-action',profile.id,{type:'promote',id:tools.projects[0].tabs[0].id});
  const second=(await harness.createMain()).activeTabId!;
  assert.notEqual(harness.spawns[0]!.env.COPILOT_DESKTOP_BROWSER_STATE,harness.spawns[1]!.env.COPILOT_DESKTOP_BROWSER_STATE);
  await harness.request('desktop:activate-tab',first);await harness.request('desktop:restart-tab',first);
  assert.equal(harness.spawns[2]!.env.COPILOT_DESKTOP_BROWSER_STATE,harness.spawns[0]!.env.COPILOT_DESKTOP_BROWSER_STATE);
  assert.deepEqual((await harness.request<any>('desktop:tools-state')).connections.map((connection:any)=>connection.sessionId).sort(),[first,second].sort(),'both live sessions retain their bridges');
  await harness.request('desktop:close-tab',first);await harness.request('desktop:close-tab',second);
  assert.equal((await harness.request<any>('desktop:browser-state',resource)).url,'https://first.example/');
  assert.equal(harness.browserConfigs.length,1);
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
  const other = await harness.request('desktop:create-tab', null, second.id)
  const raised = await harness.request('desktop:activate-tab', firstId)
  assert.equal(raised.activeProfileId, second.id, 'raising a detached window keeps the main workspace')
  assert.equal(raised.activeTabId, other.activeTabId)
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

test('read-only migration preserves pending sessions, typing and resize while import admission counts pending creation', migrationOnly, async () => fixture(async (harness, directory) => {
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

test('export IPC snapshots settings while a Desktop session stays open and accepts input', migrationOnly, async () => fixture(async (harness, directory) => {
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

test('export IPC silences only expected cancellation from a destroyed Settings sender', migrationOnly, async () => fixture(async (harness, directory) => {
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

test('closed Settings cancellation is quiet for inventory, archive open and preview', migrationOnly, async () => fixture(async (harness, directory) => {
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

test('import IPC quiets completed cancellation rollback but preserves failed rollback and live-sender errors', migrationOnly, async () => fixture(async (harness, directory) => {
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
  await assert.rejects(async () => harness.requestSettings('desktop-settings:install-update'), /source collection failed/)
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
  const installing = assert.rejects(async () => harness.requestSettings('desktop-settings:install-update'), /failed while preparing/)
  await began; harness.updateError()
  assert.equal(harness.updateBusy(), true)
  await assert.rejects(async () => harness.requestSettings('desktop-settings:install-update'), /already in progress/)
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
  const installing = assert.rejects(async () => harness.requestSettings('desktop-settings:install-update'), /deadline/)
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
  await assert.rejects(async () => harness.requestSettings('desktop-settings:check-for-updates'), /already in progress/)
  await assert.rejects(async () => harness.requestSettings('desktop-settings:download-update'), /already in progress/)
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
  await assert.rejects(async () => harness.requestSettings('desktop-settings:install-update'), /already in progress/)
}))

test('usage failures neither block CLI maintenance nor misreport a successful CLI update', async () => fixture(async (harness) => {
  harness.configureMaintenance()
  await harness.maintain('install')
  assert.equal(harness.maintenanceStatus(), 'succeeded')
  await harness.maintain('update')
  assert.equal(harness.maintenanceStatus(), 'succeeded')
  assert.deepEqual(harness.maintenanceCalls, ['install', 'retry-resolution', 'update', 'retry-resolution'])
}))

test('installing or updating the CLI and starting a Copilot session keep each other out', async () => fixture(async (harness, directory) => {
  configure(harness, directory)
  harness.configureMaintenance()
  let finish!: () => void
  harness.holdMaintenance(new Promise<void>((resolve) => { finish = resolve }))
  // No session is running, so the update is admitted. A session started while it runs would launch the program that is
  // being replaced.
  const updating = harness.maintain('update')
  for (let turn = 0; turn < 20 && !harness.maintenanceCalls.includes('update'); turn++) await new Promise((resolve) => setImmediate(resolve))
  assert.ok(harness.maintenanceCalls.includes('update'), 'the update command is running')
  assert.equal(harness.maintenanceStatus(), 'running')
  await assert.rejects(harness.createMain(), /Copilot CLI is being installed or updated/)
  assert.equal(harness.spawns.length, 0)
  finish()
  await updating
  assert.equal(harness.maintenanceStatus(), 'succeeded')

  // The other way round: a session that is still being prepared is not in the list of running tabs yet.
  let prepared!: () => void
  harness.blockSpawnPlan(new Promise<void>((resolve) => { prepared = resolve }))
  const starting = harness.createMain()
  await new Promise((resolve) => setImmediate(resolve))
  await assert.rejects(harness.maintain('update'), /A session is starting or stopping/)
  prepared()
  const opened = await starting
  assert.equal(harness.spawns.length, 1)
  await assert.rejects(harness.maintain('update'), /Close all running Copilot sessions/)
  await harness.request('desktop:close-tab', opened.activeTabId)
  await harness.maintain('update')
  assert.equal(harness.maintenanceStatus(), 'succeeded')
}))

test('a session cannot slip in between the checks of a CLI update and the update itself', async () => fixture(async (harness, directory) => {
  configure(harness, directory)
  harness.configureMaintenance()
  // The update is admitted, then waits for usage to be written before it runs the command.
  let flushed!: () => void
  harness.holdUsageFlush(new Promise<void>((resolve) => { flushed = resolve }))
  const updating = harness.maintain('update')
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(harness.maintenanceCalls.includes('update'), false, 'the command has not started yet')
  await assert.rejects(harness.createMain(), /Copilot CLI is being installed or updated/)
  assert.equal(harness.spawns.length, 0)
  flushed()
  await updating
  assert.equal(harness.maintenanceStatus(), 'succeeded')
}))

test('a settings save that fails at startup is logged and does not stop the app from starting', async () => fixture(async (harness, directory) => {
  configure(harness, directory)
  const logged = await harness.startupSaveWithFailingDisk()
  assert.equal(logged.length, 1)
  assert.match(logged[0]!, /Could not save the settings at startup.*ENOSPC/)
}))

test('at the workspace limit a workspace with saved sessions or open tools is never dropped; an idle one is, with its cleanup', async () => fixture(async (harness, directory) => {
  const { profile, capabilities } = configure(harness, directory)
  harness.createTestWindow()
  const others: WorkspaceProfile[] = []
  for (let index = 1; index < 20; index++) {
    const path = join(directory, `workspace-${index}`); await mkdir(path)
    const other = createWorkspaceProfile(path)
    other.tabs = [{ title: `Saved ${index}`, lastSessionId: SOURCE }]
    others.push(other)
  }
  profile.tabs = [{ title: 'Saved', lastSessionId: FORK }]
  harness.configure({ ...structuredClone(DEFAULT_DESKTOP_CONFIG), profiles: [profile, ...others], activeProfileId: profile.id }, capabilities)
  const removals = harness.watchProjectRemovals()
  const added = join(directory, 'one-more'); await mkdir(added)
  harness.chooseFolder(added)

  // Every workspace has a session saved to open again. Adding one more used to drop the last of them, silently.
  const asked = harness.answerMessageBoxes(0)
  let state = await harness.request('desktop:select-workspace')
  assert.equal(asked.length, 1)
  assert.match(asked[0]!.message, /All 20 workspaces are in use/)
  assert.equal(state.profiles.length, 20)
  assert.ok(state.profiles.every((candidate) => candidate.path !== added))
  assert.deepEqual(removals, [])

  // Tools open in a workspace with no sessions keep it too.
  const last = others.at(-1)!
  last.tabs = []
  harness.configure({ ...structuredClone(DEFAULT_DESKTOP_CONFIG), profiles: [profile, ...others], activeProfileId: profile.id }, capabilities)
  await harness.request<unknown>('desktop:tools-action', last.id, { type: 'add', kind: 'browser' })
  state = await harness.request('desktop:select-workspace')
  assert.equal(asked.length, 2)
  assert.ok(state.profiles.some((candidate) => candidate.id === last.id))

  // With nothing in it, it makes room, and is cleaned up like a workspace removed by hand.
  const tools = await harness.request<any>('desktop:tools-state')
  const open = tools.projects.find((project: any) => project.profileId === last.id)?.tabs ?? []
  assert.ok(open.length > 0)
  for (const tab of open) await harness.request('desktop:tools-action', last.id, { type: 'close', id: tab.id })
  state = await harness.request('desktop:select-workspace')
  assert.equal(asked.length, 2, 'no refusal this time')
  assert.equal(state.profiles.length, 20)
  assert.ok(state.profiles.some((candidate) => candidate.path === added))
  assert.ok(state.profiles.every((candidate) => candidate.id !== last.id))
  assert.deepEqual(removals, [last.id])
}))

test('saving a captured browser log copies the browser state once, however long the log is', async () => fixture(async (harness, directory) => {
  const { profile } = configure(harness, directory); harness.createTestWindow()
  const tools = await harness.request<any>('desktop:tools-action', profile.id, { type: 'add', kind: 'browser' })
  const tab = tools.projects[0].tabs[0].resource
  const browser = await harness.request<any>('desktop:browser-open', tab)
  for (let index = 0; index < 300; index++) browser.console.push({ pageId: 12, message: `line ${index}` })
  harness.configureBrowserExportDialog({ canceled: false, filePath: join(directory, 'log.json') })
  const copies = harness.countBrowserSnapshots(tab)
  await harness.request('desktop:browser-export', tab, 'console')
  // One to check that this tab is the one shown, one for the log. It was one more for every entry in the log.
  assert.equal(copies.count, 2)
  assert.equal(JSON.parse(await readFile(join(directory, 'log.json'), 'utf8')).length, 300)
}))

test('activity in several sessions is shown by one broadcast a second, not one for each session', async (t) => fixture(async (harness, directory) => {
  configure(harness, directory)
  const tabs: string[] = []
  for (let index = 0; index < 5; index++) tabs.push((await harness.createMain()).activeTabId!)
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const sent = harness.countBroadcasts()
  // Five sessions working at once, their tools starting a fifth of a second apart, for three seconds.
  for (let tick = 0; tick < 15; tick++) {
    harness.activityChanged(tabs[tick % 5]!)
    t.mock.timers.tick(200)
  }
  t.mock.timers.tick(1_000)
  // Three seconds of activity and the second after it: one broadcast a second. It was one a second for each session.
  assert.ok(sent.count >= 3 && sent.count <= 4, `${sent.count} broadcasts`)
  // Nothing more is sent once the sessions are quiet.
  const quiet = sent.count
  t.mock.timers.tick(5_000)
  assert.equal(sent.count, quiet)
  // Closing a tab takes nothing away from the others: there is no timer of its own to clear, and their next change is
  // still shown, once.
  t.mock.timers.reset()
  await harness.request('desktop:close-tab', tabs[0]!)
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const after = harness.countBroadcasts()
  harness.activityChanged(tabs[1]!)
  harness.activityChanged(tabs[2]!)
  t.mock.timers.tick(1_000)
  assert.equal(after.count, 1)
  t.mock.timers.reset()
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
  await harness.request('desktop:restart-tab', opened.tabs[0]!.id)
  assert.equal(harness.browserConfigs.length, 0, 'restoring or restarting CLI tabs does not open browsers')
  const restarted = await harness.request('desktop:restart-tab', opened.tabs[0]!.id)
  assert.deepEqual(restarted.tabs.map(tab => tab.browserProfileId), opened.tabs.map(tab => tab.browserProfileId))
  await harness.flushConfig()
  const saved = JSON.parse(await readFile(join(directory, 'desktop.json'), 'utf8')) as DesktopConfig
  assert.deepEqual(saved.profiles[0]!.tabs.map(tab => tab.browserProfileId), opened.tabs.map(tab => tab.browserProfileId))
}))

test('a Settings window whose page fails to load is destroyed, so the next open starts again', async () => fixture(async (harness, directory) => {
  configure(harness, directory)
  harness.createTestWindow()
  harness.failSettingsLoad(true)
  await assert.rejects(async () => harness.request('desktop:open-settings'), /page load failed/)
  assert.equal(harness.settingsWindow(), null, 'no hidden blank window is kept for the next open to show')
  harness.failSettingsLoad(false)
  await harness.request('desktop:open-settings')
  assert.equal(harness.settingsWindow()?.destroyed, false)
}))

test('Ctrl/Cmd+W and +T as menu accelerators in the main window are handed to the page, which knows what has focus', async () => fixture(async (harness, directory) => {
  configure(harness, directory)
  harness.createTestWindow()
  const tab = (await harness.createMain()).activeTabId!
  harness.refreshAppMenu()
  const window = harness.windowFor()
  const file = (window.menu as { label?: string; submenu?: { label?: string; click?: (...args: unknown[]) => void }[] }[]).find(item => item.label === 'File')!.submenu!
  const item = (label: string) => file.find(entry => entry.label === label)!
  const requests = () => window.messages.filter(message => message.channel === 'desktop:tab-shortcut-request').map(message => message.payload)
  const newSessions = () => window.messages.filter(message => message.channel === 'desktop:new-session-request').length
  harness.focusMainWindow(true)
  item('Close Session Tab').click!({}, undefined, { triggeredByAccelerator: true })
  item('New Session Tab').click!({}, undefined, { triggeredByAccelerator: true })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(requests(), ['w', 't'])
  assert.equal(newSessions(), 0)
  assert.ok((await harness.request('desktop:get-state') as DesktopState).tabs.some(entry => entry.id === tab), 'the accelerator did not close the session by itself')
  // Chosen with the mouse, or with another window focused, the items act on the session as they are labelled.
  item('New Session Tab').click!({}, undefined, { triggeredByAccelerator: false })
  assert.equal(newSessions(), 1)
  harness.focusMainWindow(false)
  item('New Session Tab').click!({}, undefined, { triggeredByAccelerator: true })
  assert.equal(newSessions(), 2)
  assert.deepEqual(requests(), ['w', 't'])
}))

test('a main window whose page process died loads the page again, a bounded number of times, then asks', async () => fixture(async (harness, directory) => {
  configure(harness, directory)
  harness.createTestWindow()
  const tab = (await harness.createMain()).activeTabId!
  const window = harness.windowFor()
  const settle = async (): Promise<void> => { for (let turn = 0; turn < 5; turn++) await new Promise(resolve => setImmediate(resolve)) }
  await settle()
  const loaded = window.loads
  const asked = harness.answerMessageBoxes(1)
  for (let death = 1; death <= 3; death++) {
    window.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 5 })
    await settle()
    assert.equal(window.loads, loaded + death, 'the page is loaded again')
  }
  assert.equal(asked.length, 0)
  // The fourth death within a minute is a page that cannot stay up: no reload until the person asks for one.
  window.webContents.emit('render-process-gone', {}, { reason: 'oom', exitCode: 6 })
  await settle()
  assert.equal(window.loads, loaded + 3)
  assert.equal(asked.length, 1)
  assert.match((asked[0] as { detail: string }).detail, /sessions are still running/)
  harness.answerMessageBoxes(0)
  window.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 5 })
  await settle()
  assert.equal(window.loads, loaded + 4, 'Reload was chosen')
  // A page that closed normally, and a window that only stopped responding, are logged and left alone.
  window.webContents.emit('render-process-gone', {}, { reason: 'clean-exit', exitCode: 0 })
  window.emit('unresponsive')
  window.emit('responsive')
  await settle()
  assert.equal(window.loads, loaded + 4)
  assert.equal(window.destroyed, false)
  assert.ok((await harness.request('desktop:get-state') as DesktopState).tabs.some(entry => entry.id === tab), 'the session outlives its page')
  await harness.flushAppLog()
  const log = await readFile(join(directory, 'logs', 'app.log'), 'utf8')
  assert.equal(log.match(/Main window page process ended \(reason=crashed exitCode=5\); loading the page again/g)?.length, 3)
  assert.match(log, /Main window page process ended \(reason=oom exitCode=6\); it keeps ending/)
  assert.match(log, /Main window page process ended: reason=clean-exit exitCode=0/)
  assert.match(log, /Main window stopped responding/)
  assert.match(log, /Main window is responding again/)
}))

test('fan-out readiness answers one word per session: waiting, ready, in its own window, or gone', async () => fixture(async (harness, directory) => {
  configure(harness, directory)
  harness.createTestWindow()
  const tab = (await harness.createMain()).activeTabId!
  const readiness = (id: unknown): Promise<unknown> => Promise.resolve(harness.request('desktop:fan-out-readiness', id))
  assert.equal(await readiness(tab), 'waiting')
  harness.spawns[0]!.emitData('\x1b[?2004h> \r\n <- open sidebar | / commands\r\n')
  assert.equal(await readiness(tab), 'ready')
  await harness.request('desktop:pop-out-tab', tab)
  assert.equal(await readiness(tab), 'elsewhere')
  assert.equal(await readiness('tab-99'), 'gone')
  await assert.rejects(async () => readiness('../etc'), /Invalid session tab/)
  await assert.rejects(async () => readiness(7), /Invalid session tab/)
}))

test('session output is written to that session\'s log in order, and is all there once its tab has closed', async () => fixture(async (harness, directory) => {
  configure(harness, directory)
  harness.createTestWindow()
  const first = (await harness.createMain()).activeTabId!
  const second = (await harness.createMain()).activeTabId!
  for (const chunk of ['one ', 'two ', 'three']) harness.spawns[0]!.emitData(chunk)
  harness.spawns[1]!.emitData('other session')
  await harness.request('desktop:close-tab', first)
  await harness.request('desktop:close-tab', second)
  const sessions = join(directory, 'logs', 'sessions')
  const [launch] = await readdir(sessions)
  assert.ok((await readFile(join(sessions, launch!, `${first}.log`), 'utf8')).includes('one two three'))
  assert.ok((await readFile(join(sessions, launch!, `${second}.log`), 'utf8')).includes('other session'))
  assert.ok(!(await readFile(join(sessions, launch!, `${first}.log`), 'utf8')).includes('other session'))
}))

test('the Settings page turns opening files outside the workspace on and off, saved, and accepts only true or false', async () => fixture(async (harness, directory) => {
  const profile = createWorkspaceProfile(directory, 'default')
  // The tray off, as the other preference tests: the harness has no tray to create when a save refreshes it.
  harness.configure({ ...DEFAULT_DESKTOP_CONFIG, trayEnabled: false, profiles: [profile], activeProfileId: profile.id }, EMPTY_COPILOT_CAPABILITIES)
  const get = async (): Promise<boolean> => (await harness.requestSettings('desktop-settings:get') as { openFilesOutsideWorkspace: boolean }).openFilesOutsideWorkspace
  assert.equal(await get(), false, 'off by default')
  for (const value of ['true', 1, null]) {
    await assert.rejects(async () => harness.requestSettings('desktop-settings:update-preferences', { openFilesOutsideWorkspace: value }), /Invalid desktop preferences/)
  }
  assert.equal(await get(), false)
  await harness.requestSettings('desktop-settings:update-preferences', { openFilesOutsideWorkspace: true })
  assert.equal(await get(), true)
  await harness.flushConfig()
  assert.equal(JSON.parse(await readFile(join(directory, 'desktop.json'), 'utf8')).openFilesOutsideWorkspace, true)
  await harness.requestSettings('desktop-settings:update-preferences', { openFilesOutsideWorkspace: false })
  await harness.flushConfig()
  assert.equal(JSON.parse(await readFile(join(directory, 'desktop.json'), 'utf8')).openFilesOutsideWorkspace, false)
}))

test('outside files: a link back into the workspace uses its tab, turning the setting off stops watching outside folders, and a link to a share is refused', async () => fixture(async (harness, directory) => {
  const workspace = join(directory, 'workspace'), outside = join(directory, 'outside')
  await mkdir(join(workspace, 'src'), { recursive: true }); await mkdir(outside)
  await writeFile(join(workspace, 'src', 'inside.txt'), 'inside\n'); await writeFile(join(outside, 'secret.txt'), 'outside\n')
  // From outside, a link back into the workspace's src folder.
  await symlink(join(workspace, 'src'), join(outside, 'back'), process.platform === 'win32' ? 'junction' : 'dir')
  // The workspace is known by a path that is not its real one, as a temp folder is on macOS (/var is /private/var) and
  // on Windows runners (a short 8.3 name): resolving the link above gives the real path, which must still match it.
  const alias = join(directory, 'workspace-alias')
  await symlink(workspace, alias, process.platform === 'win32' ? 'junction' : 'dir')
  const profile = createWorkspaceProfile(alias, 'default')
  harness.configure({ ...DEFAULT_DESKTOP_CONFIG, trayEnabled: false, profiles: [profile], activeProfileId: profile.id }, EMPTY_COPILOT_CAPABILITIES)
  harness.createTestWindow()
  const open = (path: string) => harness.request('desktop:open-file', { profileId: profile.id, folder: alias }, path, null) as Promise<{ ok: boolean; reason?: string; revealed?: boolean }>
  const fileTabs = async () => (await harness.request('desktop:tools-state', 800) as { projects: { profileId: string; tabs: { id: string; kind: string; file?: { root: string; path: string } }[] }[] }).projects.find(p => p.profileId === profile.id)!.tabs.filter(tab => tab.kind === 'file')
  await harness.requestSettings('desktop-settings:update-preferences', { openFilesOutsideWorkspace: true })

  // A link from outside that leads back into the workspace opens the workspace file in the tab it already has.
  assert.deepEqual(await open('src/inside.txt'), { ok: true })
  assert.deepEqual(await open(join(outside, 'back', 'inside.txt')), { ok: true })
  const inside = await fileTabs()
  assert.equal(inside.length, 1, 'one tab for the workspace file, however it was reached')
  assert.equal(inside[0]!.file!.path, 'src/inside.txt')

  // An outside file, watched while it is shown; turning the setting off stops that watch, the workspace one stays.
  assert.deepEqual(await open(join(outside, 'secret.txt')), { ok: true })
  const outsideTab = (await fileTabs()).find(tab => tab.file!.path === 'secret.txt')!
  await harness.request('desktop:file-watch', profile.id, outsideTab.id, true)
  await harness.request('desktop:file-watch', profile.id, inside[0]!.id, true)
  assert.ok(harness.watchedFile(outsideTab.id)?.endsWith('secret.txt'))
  assert.ok(harness.watchedFile(inside[0]!.id)?.endsWith('inside.txt'))
  const fileChanges = (from: number) => harness.windowFor().messages.slice(from).filter(message => message.channel === 'desktop:file-changed').map(message => message.payload)
  // A save that fails is rolled back: the setting stays on, the outside tab stays watched and is not told to clear.
  await harness.flushConfig()
  const config = join(directory, 'desktop.json')
  const saved = await readFile(config, 'utf8')
  await rm(config); await mkdir(config)
  const beforeFailure = harness.windowFor().messages.length
  await assert.rejects(async () => harness.requestSettings('desktop-settings:update-preferences', { openFilesOutsideWorkspace: false }))
  await new Promise(resolve => setTimeout(resolve, 100))
  assert.equal((await harness.requestSettings('desktop-settings:get') as { openFilesOutsideWorkspace: boolean }).openFilesOutsideWorkspace, true, 'rolled back')
  assert.ok(harness.watchedFile(outsideTab.id)?.endsWith('secret.txt'), 'a failed save leaves the watch alone')
  assert.deepEqual(fileChanges(beforeFailure), [], 'a failed save tells no tab to read again')
  await rm(config, { recursive: true }); await writeFile(config, saved)
  const changed = harness.windowFor().messages.length
  await harness.requestSettings('desktop-settings:update-preferences', { openFilesOutsideWorkspace: false })
  // Rechecked once the save is done, before the request answers.
  assert.equal(harness.watchedFile(outsideTab.id), null, 'no folder outside the workspace stays watched')
  assert.ok(harness.watchedFile(inside[0]!.id)?.endsWith('inside.txt'), 'the workspace file is still watched')
  const told = harness.windowFor().messages.slice(changed).filter(message => message.channel === 'desktop:file-changed').map(message => message.payload)
  assert.ok(told.includes(outsideTab.id), 'the outside tab is told to read again, so it clears')
  // The workspace tab, reached through the outside link, still reads with the setting off.
  const read = await harness.request('desktop:file-read', profile.id, inside[0]!.id, null) as { status: string }
  assert.equal(read.status, 'ok')

  // A link that resolves to a network path is refused, even with the setting on, and nothing is shown in the file
  // manager. This computer's own admin share stands in for a network share; the case runs only where it resolves.
  if (process.platform === 'win32') {
    await harness.requestSettings('desktop-settings:update-preferences', { openFilesOutsideWorkspace: true })
    const share = '\\\\localhost\\c$\\Windows'
    const { realpath, readlink } = await import('node:fs/promises')
    const reachable = await realpath(share).then(real => real.startsWith('\\\\'), () => false)
    await symlink(share, join(outside, 'share'), 'dir').catch(() => undefined)
    const linked = await readlink(join(outside, 'share')).catch(() => null)
    if (reachable && linked) {
      const reveals = harness.shellCalls.length
      assert.deepEqual(await open(join(outside, 'share')), { ok: false, reason: 'outside-workspace' }, 'a folder behind a link to a network path')
      assert.equal(harness.shellCalls.length, reveals, 'nothing was shown in the file manager')
    } else console.log(`# network-path link case not run: share reachable ${reachable}, link made ${Boolean(linked)}`)
  }
}))

test('explicit CLI close removes legacy profile settings and helper files', async () => fixture(async (harness, directory) => {
  configure(harness, directory)
  harness.createTestWindow()
  const opened = await harness.createMain()
  const tab = opened.tabs[0]!
  const profile = join(directory, 'browser-profiles', tab.browserProfileId!)
  await mkdir(profile, { recursive: true })
  await writeFile(join(profile, 'settings.json'), 'saved-page')
  await mkdir(join(directory, 'Partitions', encodeURIComponent(`browser-debug:${tab.browserProfileId}`)), { recursive: true })
  const helper = harness.spawns[0]!.env.COPILOT_DESKTOP_BROWSER_HELPER!
  await access(helper)
  const closed = await harness.request('desktop:close-tab', tab.id)
  assert.equal(closed.tabs.length, 0)
  await assert.rejects(access(profile))
  await assert.rejects(access(helper))
  assert.deepEqual(harness.browserStorageClears.map(entry => entry.operation), ['closeAllConnections', 'clearData', 'clearCache', 'clearAuthCache'])
  assert.ok(harness.browserStorageClears.every(entry => entry.partition === `persist:browser-debug:${tab.browserProfileId}`))
  await assert.rejects(async () => harness.request('desktop:browser-state', tab.id), /closed/)
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
    await assert.rejects(async () => harness.request('desktop:restart-tab', opened.activeTabId), /Could not determine Copilot CLI capabilities/)
    assert.equal(harness.spawns.length, 1)
    assert.equal(harness.spawns[0]!.stopped, false)
  })
})

test('Restricted mode is refused when capability detection failed, and a restart leaves the session running', async () => {
  await fixture(async (harness, directory) => {
    const { profile, capabilities } = configure(harness, directory)
    profile.permissionPreset = 'read-only'
    const opened = await harness.createMain()
    assert.ok(harness.spawns[0]!.args.includes('--available-tools=view,glob,grep,ask_user'))
    capabilities.probeFailed = true
    capabilities.toolAllowlist = false
    await assert.rejects(async () => harness.request('desktop:restart-tab', opened.activeTabId), /Restricted mode was not started/)
    assert.equal(harness.spawns.length, 1)
    assert.equal(harness.spawns[0]!.stopped, false)
    await assert.rejects(harness.createMain(), /Restricted mode was not started/)
    assert.equal(harness.spawns.length, 1)
  })
})

test('a probe that failed at startup is asked again at launch, for Restricted mode with launch options too', async () => {
  await fixture(async (harness, directory) => {
    const { profile, capabilities } = configure(harness, directory)
    profile.permissionPreset = 'read-only'
    profile.launch.mode = 'plan'
    const working = { ...capabilities, supportedOptions: [...capabilities.supportedOptions] }
    capabilities.probeFailed = true
    capabilities.toolAllowlist = false
    const rechecks = harness.recheckFinds(working)
    await harness.createMain()
    assert.equal(rechecks.count, 1)
    assert.ok(harness.spawns[0]!.args.includes('--available-tools=view,glob,grep,ask_user'))
    assert.ok(!harness.spawns[0]!.args.includes('--deny-tool=write'))
    // Detection works now, so the next launch does not ask again.
    await harness.createMain()
    assert.equal(rechecks.count, 1)
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
    await assert.rejects(async () => harness.request('desktop:restart-tab', sideId), /tool allowlists/)
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
    await assert.rejects(async () => harness.request('desktop:fork-side-chat', main.activeTabId, SOURCE, 'Different title'), /already has a side chat/)
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
  assert.deepEqual(harness.spawns.map(spawn => spawn.cwd), [directory], 'the other workspace tab waits for Resume')
  assert.ok(harness.spawns[0]!.args.includes(`--resume=${SOURCE}`))
  assert.deepEqual(state.tabs.map(tab => tab.status), ['running', 'dormant'])
  assert.equal(state.activeProfileId, profile.id)
  assert.equal(state.tabs.find(tab => tab.id === state.activeTabId)?.workspaceProfileId, profile.id)
  await harness.flushConfig()
  const saved = JSON.parse(await readFile(join(directory, 'desktop.json'), 'utf8')) as DesktopConfig
  assert.equal(saved.activeProfileId, profile.id)
  assert.deepEqual(saved.profiles.map(entry => entry.tabs.length), [1, 1, 0])
  // Showing it does not start it; Resume does.
  await harness.request('desktop:activate-tab', state.tabs[1]!.id)
  await new Promise((resolve) => setTimeout(resolve, 200))
  assert.equal(harness.spawns.length, 1, 'showing a stopped tab does not start it')
  await harness.request('desktop:restart-tab', state.tabs[1]!.id)
  assert.equal(harness.spawns.length, 2)
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

test('a restart starts only the tab that was on screen, and every other tab waits for Resume', async () => fixture(async (harness, directory) => {
  const { profile } = configure(harness, directory)
  // Two sessions with one name: the one on screen was not the last one saved.
  profile.tabs = [{ title: 'x', lastSessionId: SOURCE, active: true }, { title: 'x', lastSessionId: FORK }]
  await harness.restore()
  const state = await harness.request('desktop:get-state')
  assert.equal(state.activeTabId, state.tabs[0]!.id)
  assert.deepEqual(state.tabs.map(tab => tab.status), ['running', 'dormant'])
  assert.equal(harness.spawns.length, 1)
  assert.ok(harness.spawns[0]!.args.some(arg => arg.endsWith(SOURCE)), harness.spawns[0]!.args.join(' '))
  await harness.request('desktop:activate-tab', state.tabs[1]!.id)
  await new Promise((resolve) => setTimeout(resolve, 200))
  assert.equal(harness.spawns.length, 1, 'showing the stopped tab does not start it')
  await harness.flushConfig()
  const saved = JSON.parse(await readFile(join(directory, 'desktop.json'), 'utf8')) as DesktopConfig
  assert.deepEqual(saved.profiles[0]!.tabs.map(tab => [tab.lastSessionId, tab.active ?? false]), [[SOURCE, false], [FORK, true]])
}))

test('dormant CLI tabs never create browsers when polled or resumed', async()=>fixture(async(harness,directory)=>{
  const {profile}=configure(harness,directory);profile.tabs=[{title:'Stopped',lastSessionId:SOURCE},{title:'Shown',lastSessionId:FORK,active:true}];
  await harness.restore();const stopped=(await harness.request('desktop:get-state')).tabs[0]!;harness.createTestWindow();
  await assert.rejects(async () => harness.request('desktop:browser-state',stopped.id),/closed/);
  await harness.request('desktop:restart-tab',stopped.id);
  await assert.rejects(async () => harness.request('desktop:browser-state',stopped.id),/closed/);
  assert.equal(harness.browserConfigs.length,0);
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

test('a restored tab whose pane measured itself before its process existed starts at the pane\'s size, as does a resumed one', async () => fixture(async (harness, directory) => {
  const { profile, capabilities } = configure(harness, directory)
  const secondPath = join(directory, 'second'); await mkdir(secondPath)
  const second = createWorkspaceProfile(secondPath)
  profile.tabs = [{ title: 'Shown first', lastSessionId: SOURCE }]
  second.tabs = [{ title: 'Shown later', lastSessionId: FORK }]
  for (const id of [SOURCE, FORK]) { await mkdir(join(directory, 'session-state', id), { recursive: true }); await writeFile(join(directory, 'session-state', id, 'events.jsonl'), '{"type":"session.start"}\n') }
  harness.configure({ ...structuredClone(DEFAULT_DESKTOP_CONFIG), profiles: [profile, second], activeProfileId: profile.id }, capabilities)
  await harness.restoreSaved()
  const state = await harness.request('desktop:get-state')
  const dormant = state.tabs.find(tab => tab.lastSessionId === FORK)!
  assert.equal(dormant.status, 'dormant')
  // The pane mounts and measures itself while the tab's process does not exist yet: nothing to resize, but the size counts.
  await harness.request('desktop:resize-tab', dormant.id, 160, 40)
  await harness.request('desktop:restart-tab', dormant.id)
  assert.equal(harness.spawns.length, 2)
  assert.deepEqual([harness.spawns[1]!.cols, harness.spawns[1]!.rows], [160, 40], 'not the 80x24 default')
  // Unloaded and resumed in the same pane, it starts at that size again rather than the default.
  await harness.request('desktop:resize-tab', dormant.id, 150, 42)
  await harness.request('desktop:unload-tab', dormant.id)
  await harness.request('desktop:restart-tab', dormant.id)
  assert.deepEqual([harness.spawns[2]!.cols, harness.spawns[2]!.rows], [150, 42])
  // A size for a tab that does not exist is not kept.
  await harness.request('desktop:resize-tab', 'tab-999', 70, 20)
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
  assert.equal(tab.processId, null)
  assert.equal(tab.lastSessionId, sessionId)
  assert.equal(harness.spawns[0]!.stopped, true)
  // Still on screen, it does not start again by itself.
  await new Promise((resolve) => setTimeout(resolve, 200))
  assert.equal(harness.spawns.length, 1, 'unloading the tab on screen sticks')
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
  assert.ok(harness.spawns[2]!.args.includes(`--resume=${sessionId}`), harness.spawns[2]!.args.join(' '))
  // Unloaded twice in a row: the second one has nothing left to stop.
  await harness.request('desktop:unload-tab', tabId)
  await harness.request('desktop:unload-tab', tabId)
  assert.equal(harness.spawns[2]!.stopped, true)
  assert.equal(harness.spawns.length, 3)
}))

test('a stored session is listed in History by its prompts and reopens in its project, once', async (t) => fixture(async (harness, directory) => {
  const { profile, capabilities } = configure(harness, directory)
  // Outside the project folder: a folder inside it would belong to the project.
  const elsewhere = `${directory}-elsewhere`; await mkdir(elsewhere)
  t.after(() => rm(elsewhere, { recursive: true, force: true }))
  harness.configure({ ...structuredClone(DEFAULT_DESKTOP_CONFIG), profiles: [profile], activeProfileId: profile.id }, capabilities)
  const store = async (id: string, cwd: string, prompt: string): Promise<void> => {
    await mkdir(join(directory, 'session-state', id), { recursive: true })
    await writeFile(join(directory, 'session-state', id, 'workspace.yaml'), `cwd: ${cwd}\nname: ${profile.name}\nuser_named: true\nbranch: main\n`)
    await writeFile(join(directory, 'session-state', id, 'events.jsonl'), [
      { type: 'session.start', data: { startTime: new Date().toISOString(), context: { cwd } } },
      { type: 'user.message', data: { content: prompt } },
    ].map((event) => JSON.stringify(event)).join('\n') + '\n')
  }
  await store(SOURCE, directory, 'fix the login bug')
  await store(FORK, elsewhere, 'explain the parser')
  const listed = await harness.request('desktop:list-session-history') as SessionHistoryEntry[]
  const login = listed.find((entry) => entry.sessionId === SOURCE)!
  assert.deepEqual([login.firstPrompt, login.projectName, login.openTabId], ['fix the login bug', profile.name, null])
  assert.equal(listed.find((entry) => entry.sessionId === FORK)!.projectName, null, 'its folder is not an open project')

  const opened = await harness.request('desktop:open-session-history', SOURCE)
  const tab = opened.tabs.find((candidate) => candidate.lastSessionId === SOURCE)!
  assert.equal(opened.activeTabId, tab.id)
  assert.equal(tab.status, 'running')
  assert.equal(tab.workspaceProfileId, profile.id)
  assert.ok(harness.spawns.at(-1)!.args.includes(`--resume=${SOURCE}`), harness.spawns.at(-1)!.args.join(' '))
  const spawned = harness.spawns.length
  // Already open: shown, not opened twice.
  const again = await harness.request('desktop:open-session-history', SOURCE)
  assert.equal(again.tabs.filter((candidate) => candidate.lastSessionId === SOURCE).length, 1)
  assert.equal(harness.spawns.length, spawned)
  assert.equal((await harness.request('desktop:list-session-history') as SessionHistoryEntry[]).find((entry) => entry.sessionId === SOURCE)!.openTabId, tab.id)

  // A session from a folder that is not open adds that folder as a project.
  const added = await harness.request('desktop:open-session-history', FORK)
  const other = added.tabs.find((candidate) => candidate.lastSessionId === FORK)!
  const otherProfile = added.profiles.find((candidate) => candidate.id === other.workspaceProfileId)!
  assert.ok(sameFolderText(otherProfile.path, elsewhere), otherProfile.path)
  assert.ok(sameFolderText(harness.spawns.at(-1)!.cwd, elsewhere), harness.spawns.at(-1)!.cwd)
  await assert.rejects(async () => harness.request('desktop:open-session-history', 'not-a-session'), /Invalid session id/)
}))

test('opening a History session in a project startup has not listed yet keeps that project\'s saved tabs', async (t) => fixture(async (harness, directory) => {
  const { profile, capabilities } = configure(harness, directory)
  const secondPath = `${directory}-second`; await mkdir(secondPath)
  t.after(() => rm(secondPath, { recursive: true, force: true }))
  const second = createWorkspaceProfile(secondPath)
  const savedThere = '55555555-5555-4555-8555-555555555555'
  profile.tabs = [{ title: 'Shown', lastSessionId: SOURCE }]
  second.tabs = [{ title: 'Saved there', lastSessionId: savedThere }]
  harness.configure({ ...structuredClone(DEFAULT_DESKTOP_CONFIG), profiles: [profile, second], activeProfileId: profile.id }, capabilities)
  await mkdir(join(directory, 'session-state', FORK), { recursive: true })
  await writeFile(join(directory, 'session-state', FORK, 'workspace.yaml'), `cwd: ${secondPath}\nname: second\n`)
  await writeFile(join(directory, 'session-state', FORK, 'events.jsonl'), `${JSON.stringify({ type: 'user.message', data: { content: 'from history' } })}\n`)
  // Startup waits on the shown tab's process, so the second project is not listed yet.
  let release!: () => void, entered!: () => void
  const started = new Promise<void>((resolve) => { entered = resolve })
  harness.setNextSpawn(() => { entered(); return new Promise<void>((resolve) => { release = resolve }) })
  const startup = harness.restoreSaved()
  await started
  try {
    const opened = await harness.request('desktop:open-session-history', FORK)
    assert.deepEqual(opened.tabs.filter((tab) => tab.workspaceProfileId === second.id).map((tab) => [tab.lastSessionId, tab.status]),
      [[savedThere, 'dormant'], [FORK, 'running']])
    await harness.flushConfig()
    const saved = JSON.parse(await readFile(join(directory, 'desktop.json'), 'utf8')) as DesktopConfig
    assert.deepEqual(saved.profiles.find((entry) => entry.id === second.id)!.tabs.map((tab) => tab.lastSessionId), [savedThere, FORK])
  } finally { release(); await startup }
  const after = await harness.request('desktop:get-state')
  assert.equal(after.tabs.filter((tab) => tab.lastSessionId === savedThere).length, 1, 'startup does not list it twice')
}))

test('unloading a CLI releases its browser and restores its tab on resume', async()=>fixture(async(harness,directory)=>{
  const {profile}=configure(harness,directory);profile.defaultResumeMode='new';harness.createTestWindow();
  const id=(await harness.createMain()).activeTabId!;
  const tools=await harness.request<any>('desktop:tools-action',profile.id,{type:'add',kind:'browser'});
  const resource=tools.projects[0].tabs[0].resource;
  await harness.request('desktop:unload-tab',id);
  assert.equal((await harness.request<any>('desktop:tools-state')).connections.length,0);
  assert.equal((await harness.request<any>('desktop:tools-state')).projects[0].tabs[0].pageId,undefined);
  await harness.request('desktop:restart-tab',id);
  await harness.request('desktop:browser-state',resource);
  assert.equal(harness.browserConfigs.length,2);
}))

test('side chat focus and raising a detached session preserve the main panel', async () => fixture(async (harness, directory) => {
  const { profile } = configure(harness, directory)
  harness.createTestWindow()
  const first = (await harness.createMain()).activeTabId!
  const tools = await harness.request<any>('desktop:tools-action', profile.id, { type: 'add', kind: 'new' })
  const tabId = tools.projects[0].activeId
  await harness.createSide(profile, first)
  assert.equal((await harness.request<any>('desktop:tools-state')).projects[0].activeId, tabId)
  const second = (await harness.createMain()).activeTabId!
  await harness.request('desktop:pop-out-tab', second)
  await harness.request('desktop:activate-tab', first)
  await harness.request('desktop:activate-tab', second)
  assert.equal((await harness.request<any>('desktop:tools-state')).projects[0].activeId, tabId)
}))

test('browser control follows its owner and reconnects after Resume', async()=>fixture(async(harness,directory)=>{
  const {profile}=configure(harness,directory);harness.createTestWindow();
  const first=(await harness.createMain()).activeTabId!;
  const opened=await harness.request<any>('desktop:tools-action',profile.id,{type:'add',kind:'browser'});
  const page=opened.projects[0].tabs[0];
  assert.deepEqual(opened.connections.map((entry:any)=>entry.sessionId),[first]);
  const second=(await harness.createMain()).activeTabId!;
  let tools=await harness.request<any>('desktop:tools-state');
  assert.equal(tools.connections.find((entry:any)=>entry.sessionId===first).pageId,page.pageId);
  assert.equal(tools.connections.find((entry:any)=>entry.sessionId===second).pageId,null);
  assert.equal(tools.projects[0].visible,false);
  await harness.request('desktop:activate-tab',first);
  tools=await harness.request<any>('desktop:tools-state');
  assert.deepEqual(tools.connections.map((entry:any)=>entry.sessionId).sort(),[first,second].sort());
  await harness.request('desktop:unload-tab',first);
  assert.deepEqual((await harness.request<any>('desktop:tools-state')).connections.map((entry:any)=>entry.sessionId),[second]);
  await harness.request('desktop:restart-tab',first);
  tools=await harness.request<any>('desktop:tools-state');
  assert.deepEqual(tools.connections.map((entry:any)=>entry.sessionId).sort(),[first,second].sort());
  assert.equal(tools.projects[0].tabs[0].resource,page.resource);
  assert.equal(harness.browserConfigs.length,2,'resume restores the released group');
}))


test('restoration links a saved side chat even when its parent follows it in the saved list', async () => fixture(async (harness, directory) => {
  const { profile } = configure(harness, directory)
  profile.tabs = [{ title: 'Side', lastSessionId: FORK, sideChat: true, sideParentSessionId: SOURCE }, { title: 'Parent', lastSessionId: SOURCE }]
  await harness.restore()
  const state = await harness.request('desktop:get-state')
  assert.equal(state.tabs.find(tab => tab.sideChat)?.sideParentTabId, state.tabs.find(tab => tab.lastSessionId === SOURCE)?.id)
  assert.deepEqual(state.tabs.map(tab => tab.status), ['running', 'running'], 'a side chat on screen at launch starts with its parent')
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
    assert.deepEqual(await harness.request('desktop:reveal-path', state.activeTabId, join('..', 'outside.txt')), { ok: false, reason: 'outside-workspace' })
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
    const changed = await waitFor(() => harness.request('desktop:get-state'), state => state.tabs[0]?.sessionPermissionMode === 'assisted',
      'the permission monitor reads the newly created session log')
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
    // The permission monitor attaches and reads the log asynchronously (output starts a read; it also polls): wait for
    // the mode rather than for a fixed time a slow runner can miss.
    const changed = await waitFor(() => harness.request('desktop:get-state'),
      (state) => state.tabs.find((tab) => tab.id === sideId)?.sessionPermissionMode === 'allow-all', 'side chat shows allow-all')
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

test('Enter appends Git cursor context once to an ordinary prompt and holds subsequent keys until submission', async () => fixture(async (harness, directory) => {
  const { profile } = configure(harness, directory)
  profile.defaultResumeMode = 'new'
  const opened = await harness.createMain()
  const id = opened.activeTabId!
  const spawn = harness.spawns[0]!
  const context = 'Git panel cursor context\nFile: src/a.ts\nCursor: new line 42\n> +needed()'
  spawn.emitData('\x1b[?2004h> \r\n <- open sidebar | / commands\r\n')
  await harness.request('desktop:write-tab', id, 'why is this code needed?')
  assert.deepEqual(await harness.request('desktop:write-tab', id, '\r', context), { gitCursorContextAttached: true })
  assert.equal(spawn.written.length, 2)
  assert.equal(spawn.written[0], 'why is this code needed?')
  assert.equal(spawn.written[1], `\x1b[200~\n\n${context}\x1b[201~`)
  await harness.request('desktop:write-tab', id, 'next draft')
  assert.equal(spawn.written.length, 2, 'new keys cannot become part of the context paste')
  await waitFor(() => spawn.written.length, value => value === 4, 'cursor prompt submitted')
  assert.deepEqual(spawn.written.slice(-2), ['\r', 'next draft'])
  await harness.request('desktop:write-tab', id, '\x03')
  for (const question of ['', '/help', '!git status', 'question\x1b[D', '\t']) {
    await harness.request('desktop:write-tab', id, question)
    const before: number = spawn.written.length
    assert.deepEqual(await harness.request('desktop:write-tab', id, '\r', context), { gitCursorContextAttached: false })
    assert.deepEqual(spawn.written.slice(before), ['\r'], `native Enter: ${JSON.stringify(question)}`)
  }
  spawn.emitData('\x1b[?2004l')
  await harness.request('desktop:write-tab', id, 'no bracketed paste')
  const before = spawn.written.length
  assert.deepEqual(await harness.request('desktop:write-tab', id, '\r', context), { gitCursorContextAttached: false })
  assert.deepEqual(spawn.written.slice(before), ['\r'], 'no unsafe multiline fallback')
  spawn.emitData('\x1b[?2004h')
  await harness.request('desktop:write-tab', id, 'no cursor reference')
  const noContext = spawn.written.length
  await harness.request('desktop:write-tab', id, '\r')
  assert.deepEqual(spawn.written.slice(noContext), ['\r'], 'a closed panel preserves native submission')
  spawn.emitData('Allow this command?')
  assert.equal((await harness.request('desktop:get-state')).tabs[0]?.status, 'approval-needed')
  await harness.request('desktop:write-tab', id, 'yes')
  const approval = spawn.written.length
  assert.deepEqual(await harness.request('desktop:write-tab', id, '\r', context), { gitCursorContextAttached: false })
  assert.deepEqual(spawn.written.slice(approval), ['\r'], 'approval input never receives code context')
}))

test('a process restart during a Git context paste cannot submit or replay input into the replacement process', async () => fixture(async (harness, directory) => {
  const { profile } = configure(harness, directory)
  profile.defaultResumeMode = 'new'
  const opened = await harness.createMain()
  const id = opened.activeTabId!
  const old = harness.spawns[0]!
  old.emitData('\x1b[?2004h <- open sidebar\r\n')
  await harness.request('desktop:write-tab', id, 'why is this needed?')
  await harness.request('desktop:write-tab', id, '\r', 'Git panel cursor context')
  await harness.request('desktop:write-tab', id, 'queued input')
  // The restart's setup outlasts the paste's 300 ms wait for its Enter, as on a slow machine; the old process still runs.
  let setUp!: () => void
  harness.blockSpawnPlan(new Promise<void>(resolve => { setUp = resolve }))
  const restarted = harness.request('desktop:restart-tab', id)
  await pause(400)
  setUp()
  await restarted
  await pause(400)
  assert.equal(old.written.length, 2, 'the old process received only the draft and paste')
  assert.deepEqual(harness.spawns[1]?.written, [], 'no old Enter or queued keys reach the replacement')
}))

test('failed restart setup restores pending input only to the original live process',async()=>{
  for(const kind of ['context','task','command','rename'])await fixture(async(h,directory)=>{
    const {profile}=configure(h,directory);profile.defaultResumeMode='new'
    const opened=await h.createMain(),id=opened.activeTabId!,old=h.spawns[0]!
    old.emitData('\x1b[?2004h <- open sidebar\r\n')
    await pause(1_650)
    if(kind==='context'){
      await h.request('desktop:write-tab',id,'person draft')
      assert.deepEqual(await h.request('desktop:write-tab',id,'\r','Git cursor context'),{gitCursorContextAttached:true})
    }else if(kind==='task')assert.equal(h.composedPaste(id).result,'sent')
    else if(kind==='command')assert.equal(h.composedCommand(id),true)
    else{
      await writeSessionName(directory,opened.tabs[0]!.lastSessionId!,'Original name');await h.refreshNames()
      await h.request('desktop:rename-tab',id,'Pending rename')
      await waitFor(()=>old.written,w=>w.includes('/rename Pending rename'),'rename paste')
    }
    await h.request('desktop:write-tab',id,' held person keys')
    const pasted=[...old.written]
    let rejectSetup!:(error:Error)=>void
    h.blockSpawnPlan(new Promise<void>((_,reject)=>{rejectSetup=reject}))
    const restart=h.request('desktop:restart-tab',id)
    const rejected=assert.rejects(restart,/setup failed/)
    await pause(450)
    assert.deepEqual(old.written,pasted,`${kind}: no Enter or held keys during setup`)
    assert.equal(h.composedPaste(id).result,'busy','no new composed submission during transition')
    assert.equal(h.composedCommand(id),false)
    rejectSetup(new Error('setup failed'));await rejected
    await waitFor(()=>old.written,w=>w.at(-1)===' held person keys',`${kind}: original input restored`)
    assert.deepEqual(old.written,[...pasted,'\r',' held person keys'],`${kind}: exactly one original submission`)
    assert.equal(h.spawns.length,1,'healthy process is retained')
    await h.request('desktop:write-tab',id,' after recovery')
    assert.equal(old.written.at(-1),' after recovery','new input is not held indefinitely')
  })
})

test('slow unload and close cancel pending Enter before stopping the process',async()=>{
  for(const action of ['unload','close'])await fixture(async(h,directory)=>{
    const {profile}=configure(h,directory);profile.defaultResumeMode='new'
    const opened=await h.createMain(),id=opened.activeTabId!,old=h.spawns[0]!
    old.emitData('\x1b[?2004h <- open sidebar\r\n')
    await h.request('desktop:write-tab',id,'original draft')
    await h.request('desktop:write-tab',id,'\r','Git cursor context')
    await h.request('desktop:write-tab',id,' held person keys')
    let release!:()=>void,started!:()=>void
    const stopping=new Promise<void>(resolve=>{started=resolve})
    h.blockSessionStop(id,new Promise<void>(resolve=>{release=resolve}),started)
    const transition=h.request(`desktop:${action}-tab`,id)
    try{
      await stopping;await pause(450)
      assert.equal(old.written.length,2,`${action}: neither Enter nor held keys reach the stopping process`)
    }finally{release();await transition}
    assert.equal(old.written.length,2,`${action}: no replay after stop`)
  })
})

test('close requested during failed restart setup wins over restoring pending input',async()=>fixture(async(h,directory)=>{
  const {profile}=configure(h,directory);profile.defaultResumeMode='new'
  const opened=await h.createMain(),id=opened.activeTabId!,old=h.spawns[0]!
  old.emitData('\x1b[?2004h <- open sidebar\r\n')
  await h.request('desktop:write-tab',id,'original draft')
  await h.request('desktop:write-tab',id,'\r','Git cursor context')
  await h.request('desktop:write-tab',id,'held keys')
  let rejectSetup!:(error:Error)=>void
  h.blockSpawnPlan(new Promise<void>((_,reject)=>{rejectSetup=reject}))
  const rejected=assert.rejects(h.request('desktop:restart-tab',id),/setup failed/)
  const close=h.request('desktop:close-tab',id)
  await pause(400);rejectSetup(new Error('setup failed'));await rejected;await close;await pause(350)
  assert.equal(old.written.length,2,'close never restores pending Enter or keys')
  assert.equal(h.spawns.length,1)
  assert.equal((await h.request('desktop:get-state')).tabs.length,0)
}))

test('failed restart setup never restores held input after a native conversation switch',async()=>fixture(async(h,directory)=>{
  const {profile}=configure(h,directory);profile.tabs=[{title:'A',lastSessionId:SOURCE}]
  const path=(id:string)=>join(directory,'session-state',id,'events.jsonl'),line=(type:string,data:object)=>JSON.stringify({type,data})+'\n'
  for(const id of [SOURCE,FORK]){await mkdir(dirname(path(id)),{recursive:true});await writeFile(path(id),line('session.start',{sessionId:id,startTime:new Date().toISOString()}))}
  await h.restoreSaved();const id=(await h.request('desktop:get-state')).activeTabId!,old=h.spawns[0]!
  h.configureBinding(id,7700,[7700]);await writeFile(join(dirname(path(SOURCE)),'inuse.7700.lock'),'');await h.refreshRecords(id)
  old.emitData('\x1b[?2004h <- open sidebar\r\n');await pause(1650)
  h.deferTaskEnter();h.queueMeetingDelivery(id,'post','Original A handoff');await h.pumpMeetingDelivery()
  assert.ok(old.written.some(text=>text.includes('Original A handoff')))
  await h.request('desktop:write-tab',id,'held A keys');const pasted=[...old.written]
  let rejectSetup!:(error:Error)=>void
  h.blockSpawnPlan(new Promise<void>((_,reject)=>{rejectSetup=reject}))
  const rejected=assert.rejects(h.request('desktop:restart-tab',id),/setup failed/)
  try{
    await writeFile(join(dirname(path(FORK)),'inuse.7700.lock'),'')
    await appendFile(path(FORK),line('session.resume',{resumeTime:new Date().toISOString()})+line('user.message',{content:'B person request',interactionId:'person-in-B'}))
    const started=await h.meetingCommand(id,'start',FORK)
    assert.equal(started.ok,true,started.message)
    assert.equal((await h.request('desktop:get-state')).tabs.find(t=>t.id===id)?.lastSessionId,FORK)
    await h.request('desktop:write-tab',id,'B draft')
  }finally{rejectSetup(new Error('setup failed'));await rejected}
  h.flushTaskEnter();await pause(400)
  assert.deepEqual(old.written,[...pasted,'B draft'],'no old Enter, Ctrl+C or A keys reach B')
  // This fixture's meeting was never opened, so once uncertain its entry is settled as a closed meeting's would be. Never still in flight.
  const old_handoff=(await h.request('desktop:get-state')).workflowDeliveries?.find(d=>d.sessionId===SOURCE)
  assert.ok(old_handoff===undefined||old_handoff.state==='uncertain',`cancelled callback reconciles the old handoff, not ${old_handoff?.state}`)
}))

test('a command dialog keeps out every automatic sender, not only meetings, until it is closed',async()=>fixture(async(h,directory)=>{
  const {profile}=configure(h,directory);profile.tabs=[{title:'A',lastSessionId:SOURCE}]
  const path=join(directory,'session-state',SOURCE,'events.jsonl')
  await mkdir(dirname(path),{recursive:true});await writeFile(path,JSON.stringify({type:'session.start',data:{sessionId:SOURCE,startTime:new Date().toISOString()}})+'\n')
  await h.restoreSaved();const id=(await h.request('desktop:get-state')).activeTabId!,pty=h.spawns[0]!
  h.configureBinding(id,7700,[7700]);await writeFile(join(dirname(path),'inuse.7700.lock'),'');await h.refreshRecords(id)
  pty.emitData('\x1b[?2004h <- open sidebar\r\n')
  await h.request('desktop:write-tab',id,'/model');await h.request('desktop:write-tab',id,'\r')
  pty.emitData(' <- open sidebar\r\n Search models\r\n Scanning local providers · ↑/↓ to navigate · enter to select\r\n')
  await h.request('desktop:write-tab',id,'\x1b[B')
  await pause(2100)
  const before=[...pty.written]
  assert.equal(h.automaticPaste(id,()=>true).result,'busy','automatic work')
  assert.equal(h.composedPaste(id).result,'busy','a composed task')
  assert.deepEqual(pty.written,before,'nothing went into the dialog')
  // Esc closes it, and the session can take work again.
  await h.request('desktop:write-tab',id,'\x1b')
  await pause(2100)
  assert.equal(h.composedPaste(id).result,'sent')
}))

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
  // The last saved tab is shown, so it starts first; the other starts when it is resumed.
  assert.ok(sameFolderText(harness.spawns[0]!.cwd, directory), `a worktree that is gone falls back to the project: ${harness.spawns[0]!.cwd}`)
  const featureTab = (await harness.request('desktop:get-state')).tabs.find((tab) => tab.title === 'Feature')!
  await harness.request('desktop:restart-tab', featureTab.id)
  assert.equal(harness.spawns.length, 2)
  assert.ok(sameFolderText(harness.spawns[1]!.cwd, feature), harness.spawns[1]!.cwd)
  const tabs = (await harness.request('desktop:get-state')).tabs
  assert.equal(tabs.find((tab) => tab.title === 'Gone')?.launchWorktreePath, undefined)
}))

test('saved tool tab metadata skips malformed entries while restoring valid tabs', async()=>fixture(async(harness,directory)=>{
  const {profile}=configure(harness,directory)
  const id='01234567-89ab-cdef-0123-456789abcdef'
  await writeFile(join(directory,'workspace-tool-tabs-v2.json'),JSON.stringify({version:2,projects:[{
    profileId:profile.id,browserProfileId:'01234567-89ab-4def-8123-456789abcdee',
    tabs:[null,{id,kind:'local',label:'Build shell',color:'#58a6ff'}],activeId:id,visible:false,width:420,
  }]}))
  harness.createTestWindow()
  const state=await harness.request<any>('desktop:tools-state')
  assert.equal(state.projects.length,1)
  assert.equal(state.projects[0].tabs.length,1)
  assert.equal(state.projects[0].tabs[0].label,'Build shell')
  assert.equal(state.projects[0].tabs[0].color,'#58a6ff')
  await harness.request('desktop:tools-action',profile.id,{type:'metadata',id,label:'Renamed shell'})
  assert.equal(await harness.flushToolPersistence(),false)
  assert.ok((await readFile(join(directory,'workspace-tool-tabs-v2.json'),'utf8')).includes('Renamed shell'))
}))

test('project Local Overrides are separate from legacy CLI tab preferences', async()=>fixture(async(harness,directory)=>{
  const {profile}=configure(harness,directory);harness.createTestWindow();
  await harness.request('desktop:tools-action',profile.id,{type:'overrides',mode:'private'});
  const tools=await harness.request<any>('desktop:tools-action',profile.id,{type:'add',kind:'browser'});
  assert.equal(harness.browserConfigs[0]!.options.devtoolsPartition,`persist:browser-devtools:${tools.projects[0].browserProfileId}`);
  await harness.createMain();await harness.createMain();
  assert.equal(harness.browserConfigs.length,1,'CLI launches do not create browser groups');
}))


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
    // Git names the folder by its real path (macOS: /private/var for /var).
    const confirmedReal = realpathSync.native(confirmed.worktree).toLowerCase()
    let accepted = harness.answerMessageBoxes(0)
    await harness.request('desktop:close-tab', confirmed.tabId)
    await harness.worktreeCleanups()
    assert.equal(accepted.length, 1)
    assert.ok(harness.shellCalls.some((call) => call.action === 'trash' && call.target.toLowerCase() === confirmedReal))
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
    await assert.rejects(async () => harness.requestSettings('desktop-settings:update-preferences', { worktreeCleanup: 'always' }), /Invalid desktop preferences/)
    const kept = await startWorktreeSession(harness, directory, git.path)
    await harness.request('desktop:close-tab', kept.tabId)
    await harness.worktreeCleanups()
    assert.equal(await exists(kept.worktree), true)
  })
})

test('a workspace with a session open or still starting cannot be removed, and one without can', async () => fixture(async (harness, directory) => {
  const first = createWorkspaceProfile(directory)
  const secondPath = join(directory, 'second'); await mkdir(secondPath)
  const thirdPath = join(directory, 'third'); await mkdir(thirdPath)
  const second = createWorkspaceProfile(secondPath), third = createWorkspaceProfile(thirdPath)
  harness.configure({ ...structuredClone(DEFAULT_DESKTOP_CONFIG), profiles: [first, second, third], activeProfileId: first.id }, EMPTY_COPILOT_CAPABILITIES)
  await harness.createMain()

  // Its tab is registered only after the launch is planned: removal must not slip in before.
  let release!: () => void
  harness.blockSpawnPlanWhen((candidate) => candidate.id === second.id, new Promise<void>((resolve) => { release = resolve }))
  const starting = harness.request('desktop:create-tab', null, second.id)
  await new Promise((resolve) => setImmediate(resolve))
  await assert.rejects(async () => harness.request('desktop:remove-profile', second.id), /A session is starting in second/)
  release()
  const started = await starting
  const tab = started.tabs.find((candidate) => candidate.workspaceProfileId === second.id)!
  assert.ok(started.profiles.some((profile) => profile.id === second.id))
  await assert.rejects(async () => harness.request('desktop:remove-profile', second.id), /Close the session open in second/)
  await assert.rejects(async () => harness.requestSettings('desktop-settings:remove-workspace-profile', second.id), /Close the session open in second/)

  await harness.request('desktop:close-tab', tab.id)
  const removed = await harness.request('desktop:remove-profile', second.id)
  assert.deepEqual(removed.profiles.map((profile) => profile.id), [first.id, third.id])
  const viaSettings = await harness.requestSettings('desktop-settings:remove-workspace-profile', third.id) as { profiles: WorkspaceProfile[] }
  assert.deepEqual(viaSettings.profiles.map((profile) => profile.id), [first.id])
  await harness.flushConfig()
  const saved = JSON.parse(await readFile(join(directory, 'desktop.json'), 'utf8'))
  assert.deepEqual(saved.profiles.map((profile: WorkspaceProfile) => profile.id), [first.id])
  assert.equal(harness.spawns.length, 2)
}))

test('a History session whose workspace is removed while its worktree is looked up opens no orphan tab', async (t) => {
  const git = await findGitForTests()
  if (!git) return t.skip('Git unavailable')
  await fixture(async (harness, directory) => {
    const { execFileSync } = await import('node:child_process')
    // Outside the first project, so History finds this one only through its linked worktree.
    const repo = `${directory}-repo`, worktree = `${directory}-repo.worktrees`
    t.after(() => Promise.all([rm(repo, { recursive: true, force: true }), rm(worktree, { recursive: true, force: true })]))
    const globalConfig = join(directory, 'gitconfig')
    writeFileSync(globalConfig, '[user]\n\tname = Test\n\temail = test@example.com\n[init]\n\tdefaultBranch = main\n')
    const env = { ...process.env, GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_NOSYSTEM: '1' }
    const run = (cwd: string, ...args: string[]): void => { execFileSync(git.path, args, { cwd, env, stdio: 'ignore' }) }
    await mkdir(repo)
    run(repo, 'init', '-q')
    writeFileSync(join(repo, 'a.txt'), 'one\n')
    run(repo, 'add', '.')
    run(repo, 'commit', '-q', '-m', 'init')
    run(repo, 'worktree', 'add', '-q', '-b', 'side', worktree, 'HEAD')
    const first = createWorkspaceProfile(directory), second = createWorkspaceProfile(repo)
    harness.configure({ ...structuredClone(DEFAULT_DESKTOP_CONFIG), profiles: [first, second], activeProfileId: first.id }, EMPTY_COPILOT_CAPABILITIES)
    await harness.createMain()
    const sessionId = randomSessionId()
    await mkdir(join(directory, 'session-state', sessionId), { recursive: true })
    await writeFile(join(directory, 'session-state', sessionId, 'workspace.yaml'), `cwd: ${worktree}\nname: Side work\nuser_named: true\nbranch: side\n`)
    await writeFile(join(directory, 'session-state', sessionId, 'events.jsonl'), [
      { type: 'session.start', data: { sessionId, startTime: new Date().toISOString(), context: { cwd: worktree } } },
      { type: 'user.message', data: { content: 'tidy the side branch' } },
    ].map((event) => JSON.stringify(event)).join('\n') + '\n')

    let release!: () => void, looking!: () => void
    const lookedUp = new Promise<void>((resolve) => { looking = resolve })
    harness.blockWorktreeLookups(new Promise<void>((resolve) => { release = resolve }), () => looking())
    const opening = harness.request('desktop:open-session-history', sessionId)
    const refused = assert.rejects(opening, /The workspace .* was removed while the session was opening/)
    // Settles early only if the open never reached the lookup, which the assertion then reports.
    await Promise.race([lookedUp, opening.catch(() => {})])
    // Nothing of the session is registered yet, so the removal itself is allowed.
    await harness.request('desktop:remove-profile', second.id)
    release()
    await refused
    const state = await harness.request('desktop:get-state')
    assert.ok(state.profiles.every((profile) => profile.id !== second.id))
    assert.ok(state.tabs.every((tab) => tab.workspaceProfileId !== second.id && tab.lastSessionId !== sessionId))
  })
})


test('automatic paste uses production draft gates and rechecks authorization before Enter without losing held person input',async()=>fixture(async(h,directory)=>{
  configure(h,directory)
  const tab=(await h.createMain()).activeTabId!,spawn=h.spawns[0]!
  spawn.emitData('\x1b[?2004h> \r\n <- open sidebar | / commands\r\n')
  await h.request('desktop:write-tab',tab,'draft')
  assert.equal(h.automaticPaste(tab,()=>true).result,'busy')
  assert.deepEqual(spawn.written,['draft'])
  await h.request('desktop:write-tab',tab,'\x03')
  await pause(2_100)
  let authorized=true
  assert.equal(h.automaticPaste(tab,()=>authorized).result,'sent')
  await h.request('desktop:write-tab',tab,'next person draft')
  authorized=false
  await pause(350)
  assert.deepEqual(spawn.written.slice(-3),['\x1b[200~bounded automatic continuation\x1b[201~','\x03','next person draft'])
  assert.ok(!spawn.written.includes('\r'),'revocation prevents submission')
}))

for(const unverifiedBeforeEnter of [false,true])test(`a rule investigation through a filesystem alias ${unverifiedBeforeEnter?'refuses Enter for an unverifiable recipient':'submits its verified recipient'}`,async t=>fixture(async(h,directory)=>{
  const git=await findGitForTests();if(!git){t.skip('Git unavailable');return}
  const {execFileSync}=await import('node:child_process')
  const repo=join(directory,'project');await mkdir(repo)
  const env={...process.env,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:join(directory,'gitconfig'),GIT_AUTHOR_NAME:'Test',GIT_AUTHOR_EMAIL:'test@example.com',GIT_COMMITTER_NAME:'Test',GIT_COMMITTER_EMAIL:'test@example.com'}
  await writeFile(join(directory,'gitconfig'),'[init]\n defaultBranch = main\n')
  const plain=(...args:string[]):string=>execFileSync(git.path,args,{cwd:repo,env,encoding:'utf8',stdio:['ignore','pipe','ignore']})
  plain('init','-q');await writeFile(join(repo,'a.txt'),'one');plain('add','.');plain('commit','-qm','init');plain('remote','add','origin','https://github.com/owner/repo.git')
  const {capabilities}=configure(h,directory),profile=createWorkspaceProfile(repo,'default')
  h.configure({...DEFAULT_DESKTOP_CONFIG,profiles:[profile],activeProfileId:profile.id},capabilities)
  await writeFile(join(repo,'a.txt'),'dirty')
  await assert.rejects(h.launchInvestigation(profile.id,plain('rev-parse','HEAD').trim(),()=>true),error=>error instanceof Error&&error.constructor.name==='AutomationLaunchRefused')
  assert.equal(h.spawns.length,0,'a checkout refusal is proven before session/worktree creation')
  await writeFile(join(repo,'a.txt'),'one')
  let authorized=true
  if(unverifiedBeforeEnter)h.deferTaskEnter()
  const launch=h.launchInvestigation(profile.id,plain('rev-parse','HEAD').trim(),()=>authorized)
  void launch.catch(()=>{})
  // Ensure a failed fixture cannot leave its production wait loop running for 90 seconds.
  try {
    await waitFor(async()=>h.spawns.length,n=>n===1,'the investigation starts one CLI')
    const spawn=h.spawns[0]!,tabId=(await h.request('desktop:get-state')).activeTabId!
    assert.ok(spawn.args.includes('--available-tools=view,glob,grep,ask_user'))
    const name=spawn.args.find(a=>a.startsWith('--worktree='))!.slice('--worktree='.length),worktree=join(`${repo}.worktrees`,name)
    plain('worktree','add','-q','-b',name,worktree,'HEAD')
    const alias=join(directory,'worktrees-alias')
    await symlink(dirname(worktree),alias,process.platform==='win32'?'junction':'dir')
    const reportedCwd=join(alias,name)
    assert.equal(await realPathNative(reportedCwd),await realPathNative(worktree))
    const sessionId=SOURCE,log=join(directory,'session-state',sessionId,'events.jsonl')
    await mkdir(dirname(log),{recursive:true});await writeFile(log,JSON.stringify({type:'session.start',data:{sessionId,startTime:new Date().toISOString(),context:{cwd:reportedCwd}}})+'\n')
    await writeFile(join(dirname(log),'inuse.7700.lock'),'')
    h.configureBinding(tabId,7700,[7700]);spawn.emitData('\x1b[?2004h> \r\n <- open sidebar | / commands\r\n')
    let launchTimeout:NodeJS.Timeout|undefined
    const receipt=await Promise.race([launch,new Promise<never>((_resolve,reject)=>{launchTimeout=setTimeout(()=>reject(new Error('The verified alias did not receive the investigation')),15000);launchTimeout.unref()})]).finally(()=>clearTimeout(launchTimeout))
    assert.equal(receipt.sessionId,sessionId)
    const snapshot=await h.request('desktop:get-state')
    assert.notEqual(snapshot.tabs[0]?.sessionCwd,snapshot.tabs[0]?.worktree?.path,'fixture exercises distinct raw and canonical spellings')
    assert.equal(snapshot.tabs[0]?.sessionPermissionPreset,'read-only')
    assert.equal(snapshot.workflowTasks?.[0]?.id,receipt.taskId)
    assert.equal(snapshot.workflowDeliveries?.[0]?.state,'submitted')
    assert.ok(!JSON.stringify(snapshot.workflowTasks).includes('fixture-secret'))
    assert.ok(!JSON.stringify(snapshot.workflowDeliveries).includes('fixture-secret'))
    if(unverifiedBeforeEnter){
      h.makeBindingUnreadable(tabId);await h.refreshRecords(tabId);h.flushTaskEnter()
      assert.ok(!spawn.written.includes('\r'),'automatic Enter still requires a verified recipient')
      assert.equal((await h.request('desktop:get-state')).workflowDeliveries?.[0]?.state,'uncertain')
    }else{await pause(350);assert.equal(spawn.written.at(-1),'\r')}
    assert.equal((await h.meetingCommand(tabId,'start',sessionId)).ok,false,'a rule turn is not person authorization')
  }finally{authorized=false;await launch.catch(()=>{})}
}))

test('a successful write to another meeting file cannot clear a failed snapshot/material write',async()=>fixture(async(h,directory)=>{
  configure(h,directory)
  const folder=join(directory,'meetings','K7QF'),blocked=join(folder,'post.md')
  await mkdir(blocked,{recursive:true})
  assert.equal(await h.meetingWrite('K7QF',blocked,'material'),true)
  assert.equal(await h.meetingWrite('K7QF',join(folder,'meeting.json'),'{}'),true)
  await rm(blocked,{recursive:true})
  assert.equal(await h.meetingWrite('K7QF',blocked,'material'),false)
}))
test('a native conversation switch before delayed Enter sends neither Enter nor cancellation to its replacement',async()=>fixture(async(h,directory)=>{
  const {profile}=configure(h,directory);profile.tabs=[{title:'A',lastSessionId:SOURCE}]
  const path=(id:string)=>join(directory,'session-state',id,'events.jsonl'),line=(type:string,data:object)=>JSON.stringify({type,data})+'\n'
  for(const id of [SOURCE,FORK]){await mkdir(dirname(path(id)),{recursive:true});await writeFile(path(id),line('session.start',{sessionId:id,startTime:new Date().toISOString()}))}
  await h.restoreSaved();const tab=(await h.request('desktop:get-state')).activeTabId!,spawn=h.spawns[0]!
  h.configureBinding(tab,7700,[7700]);await writeFile(join(dirname(path(SOURCE)),'inuse.7700.lock'),'');await h.refreshRecords(tab)
  spawn.emitData('\x1b[?2004h> \r\n <- open sidebar | / commands\r\n');await pause(1600)
  h.deferTaskEnter();h.queueMeetingDelivery(tab,'post','Automatic work intended for A');await h.pumpMeetingDelivery()
  assert.ok(spawn.written.some(text=>text.includes('Automatic work intended for A')))
  const before=spawn.written.length
  await h.request('desktop:write-tab',tab,'held draft for A')
  await writeFile(join(dirname(path(FORK)),'inuse.7700.lock'),'')
  await appendFile(path(FORK),line('session.resume',{resumeTime:new Date().toISOString()})+line('user.message',{content:'Start a review meeting in B',interactionId:'person-in-B'}))
  const started=await h.meetingCommand(tab,'start',FORK)
  assert.equal(started.ok,true,started.message)
  assert.equal((await h.request('desktop:get-state')).tabs.find(t=>t.id===tab)?.lastSessionId,FORK)
  await h.request('desktop:write-tab',tab,'new B draft')
  h.flushTaskEnter()
  assert.deepEqual(spawn.written.slice(before),['new B draft'],'neither Ctrl+C, Enter nor A’s held keys reach B; B’s own draft is untouched')
  assert.equal((await h.request('desktop:get-state')).workflowDeliveries?.find(d=>d.sessionId===SOURCE)?.state,'uncertain')
}))

for(const unverifiedBeforeEnter of [false,true])test(`long meeting code proposals ${unverifiedBeforeEnter?'wait when their recipient becomes unverifiable':'reach the verified CLI unchanged'}`,async()=>fixture(async(h,directory)=>{
  const {profile}=configure(h,directory);profile.tabs=[{title:'Restored',lastSessionId:SOURCE}]
  const log=join(directory,'session-state',SOURCE,'events.jsonl');await mkdir(dirname(log),{recursive:true})
  await writeFile(log,JSON.stringify({type:'session.start',data:{sessionId:SOURCE,startTime:new Date().toISOString()}})+'\n')
  await h.restoreSaved();const tab=(await h.request('desktop:get-state')).activeTabId!,spawn=h.spawns[0]!
  h.configureBinding(tab,7700,[7700]);await h.refreshRecords(tab)
  spawn.emitData('\x1b[?2004h> \r\n <- open sidebar | / commands\r\n');await pause(1600)
  const code='interface Login { user: string; password: string }\nconst API_KEY = process.env.SERVICE_KEY\nconst url = `${base}?token=${token}`\n'+'// ordinary review material\n'.repeat(500)
  assert.ok(code.length>12000)
  if(unverifiedBeforeEnter)h.deferTaskEnter()
  h.queueMeetingDelivery(tab,'post',code);await h.pumpMeetingDelivery()
  assert.ok(spawn.written.includes('\x1b[200~'+code+'\x1b[201~'),'review material is neither redacted nor truncated')
  const state=await h.request('desktop:get-state')
  assert.equal(state.workflowDeliveryError,null)
  assert.equal(state.workflowDeliveries?.[0]?.state,'submitted')
  assert.ok(!JSON.stringify(state.workflowDeliveries).includes('interface Login'),'the journal does not duplicate executable material')
  if(unverifiedBeforeEnter){
    h.makeBindingUnreadable(tab);await h.refreshRecords(tab);h.flushTaskEnter()
    assert.ok(!spawn.written.includes('\r'),'automatic meeting Enter waits for a verified recipient')
    assert.equal((await h.request('desktop:get-state')).workflowDeliveries?.[0]?.state,'uncertain')
  }else{await pause(350);assert.equal(spawn.written.at(-1),'\r')}
}))

test('legacy handoff reconciliation reaches the renderer while the CLI stays silent',async()=>fixture(async(h,directory)=>{
  configure(h,directory);h.createTestWindow();const tab=(await h.createMain()).activeTabId!,spawn=h.spawns[0]!
  const before=h.windowFor().messages.length
  h.queueLegacyMeeting(tab);await h.pumpMeetingDelivery()
  const updates=h.windowFor().messages.slice(before).filter(m=>m.channel==='desktop:state-changed')
  assert.ok(updates.some(m=>m.payload.workflowDeliveries?.some((d:{state:string})=>d.state==='uncertain')),'recovery is visible without a PTY activity event or reload')
  assert.deepEqual(spawn.written,[],'legacy prompts wait for a person')
}))
test('a rejected meeting intake leaves other destinations and person recovery controls available',async()=>fixture(async(h,directory)=>{
  configure(h,directory);h.createTestWindow()
  const first=(await h.createMain()).activeTabId!,second=(await h.createMain()).activeTabId!,spawn=h.spawns[1]!
  h.queueRejectedMeeting(first);await h.pumpMeetingDelivery()
  assert.match((await h.request('desktop:get-state')).workflowDeliveryError!,/1 meeting handoff/)
  spawn.emitData('\x1b[?2004h> \r\n <- open sidebar | / commands\r\n');await pause(1600)
  h.queueMeetingDelivery(second,'post','Valid other destination');await h.pumpMeetingDelivery()
  assert.ok(spawn.written.some(text=>text.includes('Valid other destination')))
  h.interruptOwnedTurn(first,true)
  const item=(await h.request('desktop:get-state')).workflowDeliveries?.find(d=>d.source==='github/interrupt')
  assert.equal(item?.state,'uncertain')
  await h.request('desktop:delivery-action',item!.id,'discard')
  assert.equal((await h.request('desktop:get-state')).workflowDeliveries?.find(d=>d.id===item!.id)?.state,'cancelled')
}))

for(const foreign of [false,true])test(`automatic interruption ${foreign?'does not type into a newly bound conversation':'stops the verified original recipient'}`,async()=>fixture(async(h,directory)=>{
  configure(h,directory);const tab=(await h.createMain()).activeTabId!,spawn=h.spawns[0]!
  h.interruptOwnedTurn(tab,foreign)
  assert.deepEqual(spawn.written,foreign?[]:['\x03'])
  assert.equal((await h.request('desktop:get-state')).workflowDeliveries?.[0]?.state,'uncertain')
}))

test('desktop input keeps delayed cancellation with its original native conversation',async()=>fixture(async(h,directory)=>{
  const {profile}=configure(h,directory);profile.tabs=[{title:'A',lastSessionId:SOURCE}]
  const path=(id:string)=>join(directory,'session-state',id,'events.jsonl'),line=(type:string,data:object)=>JSON.stringify({type,data})+'\n'
  for(const id of [SOURCE,FORK]){await mkdir(dirname(path(id)),{recursive:true});await writeFile(path(id),line('session.start',{sessionId:id,startTime:new Date().toISOString()}))}
  await h.restoreSaved();const tab=(await h.request('desktop:get-state')).activeTabId!,spawn=h.spawns[0]!
  h.configureBinding(tab,7700,[7700]);await writeFile(join(dirname(path(SOURCE)),'inuse.7700.lock'),'');await h.refreshRecords(tab)
  spawn.emitData('\x1b[?2004h> \r\n <- open sidebar | / commands\r\n');await pause(1600)
  let authorized=true
  h.deferTaskEnter();assert.equal(h.automaticPaste(tab,()=>authorized).result,'sent')
  const before=spawn.written.length
  await h.request('desktop:write-tab',tab,'held draft for A')
  await writeFile(join(dirname(path(FORK)),'inuse.7700.lock'),'')
  await appendFile(path(FORK),line('session.resume',{resumeTime:new Date().toISOString()})+line('user.message',{content:'Start a review meeting in B',interactionId:'person-in-B'}))
  const started=await h.meetingCommand(tab,'start',FORK)
  assert.equal(started.ok,true,started.message)
  assert.equal((await h.request('desktop:get-state')).tabs.find(t=>t.id===tab)?.lastSessionId,FORK)
  authorized=false;await h.request('desktop:write-tab',tab,'new B draft');h.flushTaskEnter()
  assert.deepEqual(spawn.written.slice(before),['new B draft'],'old Enter, Ctrl+C and held keys never reach B')
}))

test('follow-up readiness checks actual drafts and unresolved receipts before source refresh',async()=>fixture(async(h,directory)=>{
  configure(h,directory);const tab=(await h.createMain()).activeTabId!,spawn=h.spawns[0]!
  spawn.emitData('\x1b[?2004h> \r\n <- open sidebar | / commands\r\n');await pause(1600)
  assert.equal(h.followupReadyFor(tab),true)
  await h.request('desktop:write-tab',tab,'draft');assert.equal(h.followupReadyFor(tab),false)
  await h.request('desktop:write-tab',tab,'\x03');await pause(2100);assert.equal(h.followupReadyFor(tab),true)
  h.corruptHandoff(tab,false);assert.equal(h.followupReadyFor(tab),false)
}))

test('unverifiable binding without an identity change preserves manual task submission and held keys',async()=>fixture(async(h,directory)=>{
  const {profile}=configure(h,directory);profile.tabs=[{title:'A',lastSessionId:SOURCE}]
  const log=join(directory,'session-state',SOURCE,'events.jsonl');await mkdir(dirname(log),{recursive:true});await writeFile(log,JSON.stringify({type:'session.start',data:{sessionId:SOURCE,startTime:new Date().toISOString()}})+'\n')
  await h.restoreSaved();const tab=(await h.request('desktop:get-state')).activeTabId!,spawn=h.spawns[0]!
  h.configureBinding(tab,7700,[7700]);h.makeBindingUnreadable(tab);await h.refreshRecords(tab)
  spawn.emitData('\x1b[?2004h> \r\n <- open sidebar | / commands\r\n');await pause(1600)
  h.deferTaskEnter();assert.equal(h.composedPaste(tab).result,'sent');await h.request('desktop:write-tab',tab,'typed during the hold');h.flushTaskEnter()
  assert.deepEqual(spawn.written.slice(-2),['\r','typed during the hold'])
  assert.equal((await h.request('desktop:get-state')).workflowError,null)
}))
for(const kind of ['post','add-dir'] as const)test(`a journal decode failure blocks automatic meeting ${kind} without blocking manual input`,async()=>fixture(async(h,directory)=>{
  const {profile}=configure(h,directory);profile.tabs=[{title:'A',lastSessionId:SOURCE}]
  const log=join(directory,'session-state',SOURCE,'events.jsonl');await mkdir(dirname(log),{recursive:true});await writeFile(log,JSON.stringify({type:'session.start',data:{sessionId:SOURCE,startTime:new Date().toISOString()}})+'\n')
  await h.restoreSaved();const tab=(await h.request('desktop:get-state')).activeTabId!,spawn=h.spawns[0]!
  h.configureBinding(tab,7700,[7700]);await h.refreshRecords(tab)
  spawn.emitData('\x1b[?2004h> \r\n <- open sidebar | / commands\r\n');await pause(1600)
  h.corruptHandoff(tab);h.queueMeetingDelivery(tab,kind);await h.pumpMeetingDelivery();await pause(350)
  assert.deepEqual(spawn.written,[],'an empty fallback is not proof of an empty journal')
  assert.match((await h.request('desktop:get-state')).workflowDeliveryError!,/unavailable/)
  await h.request('desktop:write-tab',tab,'manual input');assert.equal(spawn.written.at(-1),'manual input')
}))

test('task reports require the owned current assignment and cannot complete tasks', async () => fixture(async (harness, directory) => {
  const { profile, capabilities } = configure(harness, directory)
  const line = (type: string, data: object) => JSON.stringify({ type, data }) + '\n'
  const path = join(directory, 'session-state', SOURCE, 'events.jsonl')
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, line('session.start', { sessionId: SOURCE, startTime: new Date().toISOString(), context: { cwd: directory } }))
  profile.tabs = [{ title: 'Resumed', lastSessionId: SOURCE }]
  harness.configure({ ...DEFAULT_DESKTOP_CONFIG, profiles: [profile], activeProfileId: profile.id }, capabilities)
  await harness.restoreSaved()
  const tabId = (await harness.request('desktop:get-state')).activeTabId!
  harness.enableTasks(tabId)
  harness.configureBinding(tabId, 7700, [7700])
  await writeFile(join(dirname(path), 'inuse.7700.lock'), '')
  await harness.meetingCommand(tabId, 'task-status', SOURCE)
  assert.equal((await harness.request('desktop:get-state')).workflowTasks?.length, 0, 'history is not a new task')
  await appendFile(path, line('user.message', { content: 'Fix token=fixture-secret', interactionId: 'work' }) + line('assistant.turn_start', { turnId: 'work' }))
  const status = await harness.meetingCommand(tabId, 'task-status', SOURCE)
  assert.equal(status.ok, true, status.message)
  const binding = JSON.parse(status.message)
  const report = { ...binding, outcome: 'ready', summary: 'Ready', question:'Review the rounding policy',artifacts:[{kind:'url',label:'PR',value:'https://github.com/owner/repo/pull/1'}],validation: [{name:'unit checks',status:'passed',revision:'abc123'}] }
  assert.equal((await harness.meetingCommand(tabId, 'task-report', SOURCE, JSON.stringify({...report,assignmentId:'foreign'}))).ok, false)
  assert.equal((await harness.meetingCommand(tabId, 'task-report', SOURCE, JSON.stringify(report))).ok, true)
  const tasks = (await harness.request('desktop:get-state')).workflowTasks!
  assert.equal(tasks.length, 1)
  assert.equal(tasks[0]!.outcome, 'ready')
  assert.equal(tasks[0]!.request, 'Fix token=[REDACTED]')
  assert.equal(tasks[0]!.repositoryPath,profile.path)
  assert.equal(tasks[0]!.question,'Review the rounding policy')
  assert.equal(tasks[0]!.artifacts?.[0]?.value,'https://github.com/owner/repo/pull/1')
  assert.equal(tasks[0]!.reports?.[0]?.validation[0]?.revision,'abc123')
  assert.equal((await harness.meetingCommand(tabId, 'task-report', SOURCE, JSON.stringify({...report,outcome:'completed'}))).ok, false)
  await harness.request('desktop:task-action', tasks[0]!.id, 'completed')
  assert.equal((await harness.request('desktop:get-state')).workflowTasks?.[0]?.outcome, 'completed')
}))


test('manual task controls adopt without input and replace only at an idle empty prompt',async()=>fixture(async(h,directory)=>{
  const {profile}=configure(h,directory);profile.tabs=[{title:'Existing',lastSessionId:SOURCE}]
  const log=join(directory,'session-state',SOURCE,'events.jsonl');await mkdir(dirname(log),{recursive:true});await writeFile(log,JSON.stringify({type:'session.start',data:{sessionId:SOURCE,startTime:new Date().toISOString()}})+'\n')
  await h.restoreSaved();const tab=(await h.request('desktop:get-state')).activeTabId!,spawn=h.spawns[0]!
  h.configureBinding(tab,7700,[7700]);await h.refreshRecords(tab)
  await writeFile(join(dirname(log),'inuse.7700.lock'),'');await h.refreshRecords(tab)
  h.enableTasks(tab,false)
  await h.request('desktop:task-create',tab,'Existing work',false)
  let tasks=(await h.request('desktop:get-state')).workflowTasks!;const old=tasks[0]!
  assert.equal(old.outcome,'unknown');assert.equal(spawn.written.length,0)
  await assert.rejects(async()=>h.request('desktop:task-create',tab,'Duplicate',false),/state changed/)
  spawn.emitData('\x1b[?2004h> \r\n <- open sidebar | / commands\r\n');await pause(1600)
  await h.request('desktop:write-tab',tab,'unsubmitted draft')
  await assert.rejects(async()=>h.request('desktop:task-create',tab,'Another',true),/idle/)
  assert.equal((await h.request('desktop:get-state')).workflowTasks![0]!.id,old.id)
  await h.request('desktop:write-tab',tab,'\x03');await pause(2100)
  await appendFile(log,JSON.stringify({type:'user.message',data:{content:'Old work',interactionId:'old'}})+'\n'+JSON.stringify({type:'assistant.turn_start',data:{turnId:'old'}})+'\n'+JSON.stringify({type:'assistant.message',data:{content:'Old work finished',toolRequests:[]}})+'\n'+JSON.stringify({type:'assistant.turn_end',data:{turnId:'old'}})+'\n');await h.refreshRecords(tab)
  const before=spawn.written.length
  await h.request('desktop:task-create',tab,'Another',true)
  tasks=(await h.request('desktop:get-state')).workflowTasks!;const next=tasks.find(task=>task.id!==old.id)!
  assert.equal(next.outcome,'unknown');assert.equal(tasks.find(task=>task.id===old.id)?.outcome,'cancelled')
  assert.equal(spawn.written.length,before,'task bookkeeping sends no input')
  await h.request('desktop:task-action',next.id,'blocked')
  assert.equal((await h.request('desktop:get-state')).workflowTasks!.find(task=>task.id===next.id)?.outcome,'blocked')
  await h.request('desktop:task-action',old.id,'delete')
  assert.equal((await h.request('desktop:get-state')).workflowTasks!.length,1)
  await assert.rejects(async()=>h.request('desktop:task-action',next.id,'delete'),/Only/)
}))



test('production task report notifications contain only a redacted title and app reason and baseline restored evidence',async()=>fixture(async(h,directory)=>{
  const {profile}=configure(h,directory);profile.tabs=[{title:'token=fixture-tab',lastSessionId:SOURCE}]
  const log=join(directory,'session-state',SOURCE,'events.jsonl');await mkdir(dirname(log),{recursive:true});await writeFile(log,JSON.stringify({type:'session.start',data:{sessionId:SOURCE,startTime:new Date().toISOString(),context:{cwd:directory}}})+'\n')
  await h.restoreSaved();const tab=(await h.request('desktop:get-state')).activeTabId!
  h.configureBinding(tab,7700,[7700]);await writeFile(join(dirname(log),'inuse.7700.lock'),'');await h.refreshRecords(tab);h.enableTasks(tab)
  const notices=h.captureWorkflowNotifications()
  await h.request('desktop:task-create',tab,'Tracked work',false)
  await appendFile(log,JSON.stringify({type:'user.message',data:{content:'New verified work',interactionId:'new-work'}})+'\n'+JSON.stringify({type:'assistant.turn_start',data:{turnId:'new-work'}})+'\n');await h.refreshRecords(tab)
  const binding=JSON.parse((await h.meetingCommand(tab,'task-status',SOURCE)).message)
  const report=await h.meetingCommand(tab,'task-report',SOURCE,JSON.stringify({...binding,outcome:'needs-input',summary:'Private summary',question:'Private question token=fixture-question',artifacts:[{kind:'url',label:'Private artifact',value:'https://example.com/?token=fixture-url'}]}))
  assert.equal(report.ok,true,report.message);h.flushWorkflowNotifications()
  assert.equal(notices.length,1)
  assert.match(notices[0]!.body,/token=\[REDACTED\].*Task needs input/)
  assert.doesNotMatch(JSON.stringify(notices),/fixture-(tab|question|url)|Private|example.com/)
  h.captureWorkflowNotifications()
  const task=(await h.request('desktop:get-state')).workflowTasks![0]!
  await h.request('desktop:task-action',task.id,'needs-input');h.flushWorkflowNotifications()
  assert.equal(notices.length,1,'a restored outcome and an unchanged manual outcome do not replay notices')
  await h.request('desktop:close-tab',tab)
  assert.equal((await h.request('desktop:get-state')).workflowTasks![0]!.resources?.session,'closed')
}))

test('assignment replacement refuses an unverifiable old worker while normal manual input remains available',async()=>fixture(async(h,directory)=>{
  const {profile}=configure(h,directory);profile.tabs=[{title:'Existing',lastSessionId:SOURCE}]
  const line=(type:string,data:object)=>JSON.stringify({type,data})+'\n',log=join(directory,'session-state',SOURCE,'events.jsonl')
  await mkdir(dirname(log),{recursive:true});await writeFile(log,line('session.start',{sessionId:SOURCE,startTime:new Date().toISOString(),context:{cwd:directory}}))
  await h.restoreSaved();const tab=(await h.request('desktop:get-state')).activeTabId!,spawn=h.spawns[0]!
  h.configureBinding(tab,7700,[7700]);await writeFile(join(dirname(log),'inuse.7700.lock'),'');await h.refreshRecords(tab);h.enableTasks(tab)
  spawn.emitData('\x1b[?2004h> \r\n <- open sidebar | / commands\r\n')
  await appendFile(log,line('user.message',{content:'Old work',interactionId:'old'})+line('assistant.turn_start',{turnId:'old'}));await h.refreshRecords(tab);await pause(1600)
  const old=(await h.request('desktop:get-state')).workflowTasks![0]!
  h.makeBindingUnreadable(tab);await h.refreshRecords(tab)
  await assert.rejects(async()=>h.request('desktop:task-create',tab,'New task',true),/verified|idle/)
  assert.equal((await h.request('desktop:get-state')).workflowTasks![0]!.id,old.id)
  await h.request('desktop:write-tab',tab,'person draft');assert.equal(spawn.written.at(-1),'person draft')
}))


test('a production attention broadcast reads task history once even with notifications disabled',async()=>fixture(async(h,directory)=>{
  const {profile,capabilities}=configure(h,directory);h.createTestWindow()
  const tab=(await h.createMain()).activeTabId!;h.enableTasks(tab);h.seedWorkflowHistory(30)
  h.captureWorkflowNotifications()
  h.configure({...DEFAULT_DESKTOP_CONFIG,notifications:false,profiles:[profile],activeProfileId:profile.id},capabilities)
  assert.equal(h.workflowBroadcastReads(false),1,'the ordinary snapshot is the baseline read')
  assert.equal(h.workflowBroadcastReads(true),1,'attention shares that snapshot instead of decoding it again')
}))


test('natural CLI exit revokes its browser bridge while keeping project pages', async()=>fixture(async(harness,directory)=>{
  const {profile}=configure(harness,directory);harness.createTestWindow();
  const id=(await harness.createMain()).activeTabId!;
  const tools=await harness.request<any>('desktop:tools-action',profile.id,{type:'add',kind:'browser',sessionId:id});
  const resource=tools.projects[0].tabs[0].resource;
  const endpoint=harness.spawns[0]!.env.COPILOT_DESKTOP_BROWSER_STATE!;
  await access(endpoint);harness.spawns[0]!.emitExit();
  for(let attempt=0;attempt<100 && (await harness.request<any>('desktop:get-state')).tabs.find((tab:any)=>tab.id===id).status==='running';attempt++) await pause(10);
  assert.equal((await harness.request<any>('desktop:get-state')).tabs.find((tab:any)=>tab.id===id).status,'completed');
  assert.equal((await harness.request<any>('desktop:tools-state')).connections.length,0);
  for(let attempt=0;attempt<100 && await access(endpoint).then(()=>true,()=>false);attempt++) await pause(10);
  await assert.rejects(access(endpoint));
  await harness.request('desktop:browser-state',resource);
  assert.equal(harness.browserConfigs.length,1);
  await harness.request('desktop:pop-out-tab',id);
  await harness.requestIn(id,'desktop:browser-show-main',id);
  const after=await harness.request<any>('desktop:tools-state');
  assert.equal(after.connections.length,0);
  assert.equal(after.projects[0].tabs.length,2,'completed CLI can open an unbound browser');
}))

test('retrying an uncertain meeting digest from Handoffs re-enqueues and delivers it after an aborted send', async () => fixture(async (h, directory) => {
  const { profile } = configure(h, directory)
  profile.defaultResumeMode = 'new'
  const line = (type: string, data: object) => JSON.stringify({ type, data }) + '\n'
  const sessionPath = (id: string) => join(directory, 'session-state', id, 'events.jsonl')
  const writeSession = async (id: string, events = ''): Promise<void> => {
    await mkdir(dirname(sessionPath(id)), { recursive: true })
    await writeFile(sessionPath(id), line('session.start', { sessionId: id, startTime: new Date().toISOString() }) + events)
  }

  const host = await h.createMain()
  const hostId = host.activeTabId!
  const hostSessionId = host.tabs.find(tab => tab.id === hostId)!.lastSessionId!
  const hostSpawn = h.spawns[0]!
  await writeSession(hostSessionId, line('user.message', { content: 'Start a review meeting', interactionId: 'host-start' }))
  await writeFile(join(dirname(sessionPath(hostSessionId)), 'inuse.7700.lock'), '')
  h.configureBinding(hostId, 7700, [7700])
  await h.refreshRecords(hostId)
  assert.equal((await h.meetingCommand(hostId, 'start', hostSessionId, 'Initial plan')).ok, true)
  const meetingId = (await h.request('desktop:get-state')).meetings![0]!.id
  await appendFile(sessionPath(hostSessionId),
    line('assistant.turn_start', { turnId: 'host-1' }) +
    line('assistant.message', { interactionId: 'host-start', phase: 'final_answer', content: `Meeting ${meetingId} is open.` }) +
    line('assistant.turn_end', { turnId: 'host-1' }))
  await h.refreshRecords(hostId)
  hostSpawn.emitData('\x1b[?2004h> \r\n <- open sidebar | / commands\r\n')
  await pause(1600)
  // Let the host's /add-dir setup command settle (200 ms Enter + 2 s quiet window).
  await h.pumpMeetingDelivery()
  await pause(2300)

  const reviewer = await h.request('desktop:create-tab', 'new', profile.id)
  const reviewerId = reviewer.activeTabId!
  const reviewerSessionId = reviewer.tabs.find(tab => tab.id === reviewerId)!.lastSessionId!
  const reviewerSpawn = h.spawns[1]!
  await writeSession(reviewerSessionId, line('user.message', { content: `join meeting ${meetingId}`, interactionId: 'rev-join' }))
  await writeFile(join(dirname(sessionPath(reviewerSessionId)), 'inuse.7701.lock'), '')
  h.configureBinding(reviewerId, 7701, [7701])
  await h.refreshRecords(reviewerId)
  assert.equal((await h.meetingCommand(reviewerId, 'join', reviewerSessionId)).ok, true)
  await appendFile(sessionPath(reviewerSessionId),
    line('assistant.turn_start', { turnId: 'rev-join-1' }) +
    line('assistant.message', { interactionId: 'rev-join', phase: 'final_answer', content: 'Joined.' }) +
    line('assistant.turn_end', { turnId: 'rev-join-1' }))
  await h.refreshRecords(reviewerId)
  reviewerSpawn.emitData('\x1b[?2004h> \r\n <- open sidebar | / commands\r\n')
  await pause(1600)
  await h.pumpMeetingDelivery()
  await pause(2300)
  await h.pumpMeetingDelivery()
  await pause(350)
  assert.ok(reviewerSpawn.written.some(chunk => chunk.includes('Initial plan')), 'reviewer received round 1 post')
  // Defer Enter before the reviewer finishes so the automatic pump of the host digest pauses before Enter.
  h.deferTaskEnter()
  const beforeAttempt = hostSpawn.written.length
  await appendFile(sessionPath(reviewerSessionId),
    line('user.message', { content: `[meeting ${meetingId} · round 1 · from the desktop]\nReview`, interactionId: 'rev-r1' }) +
    line('assistant.turn_start', { turnId: 'rev-r1' }) +
    line('assistant.message', { interactionId: 'rev-r1', phase: 'final_answer', content: 'Four agreed findings.' }) +
    line('assistant.turn_end', { turnId: 'rev-r1' }))
  await h.refreshRecords(reviewerId)
  assert.equal((await h.request('desktop:get-state')).meetings![0]!.stage, 'host', 'meeting moved to host stage')

  // First attempt to deliver the round-1 digest to the host aborts before Enter, leaving it uncertain.
  await h.pumpMeetingDelivery()
  assert.ok(hostSpawn.written.slice(beforeAttempt).some(chunk => chunk.includes('Four agreed findings.')))
  h.makeBindingUnreadable(hostId)
  await h.refreshRecords(hostId)
  h.flushTaskEnter()
  const uncertain = (await h.request('desktop:get-state')).workflowDeliveries?.find(d => d.scope === `meeting/${meetingId}` && d.sessionId === hostSessionId)
  assert.equal(uncertain?.state, 'uncertain')

  // Restoring the host binding and clicking Send again in Handoffs must re-enqueue and deliver the digest.
  h.configureBinding(hostId, 7700, [7700])
  await h.refreshRecords(hostId)
  hostSpawn.emitData('\x1b[?2004h> \r\n <- open sidebar | / commands\r\n')
  await pause(2100)
  const beforeRetry = hostSpawn.written.length
  await h.request('desktop:delivery-action', uncertain!.id, 'retry')
  await h.pumpMeetingDelivery()
  assert.ok(hostSpawn.written.slice(beforeRetry).some(chunk => chunk.includes('Four agreed findings.')), 'Send again re-enqueues and pastes the digest')
  h.flushTaskEnter()
  assert.equal((await h.request('desktop:get-state')).workflowDeliveries?.find(d => d.id === uncertain!.id)?.state, 'submitted')
}))

test('host manually proposing to close after an uncertain digest clears the block so the closing vote result reaches the host', async () => fixture(async (h, directory) => {
  const { profile } = configure(h, directory)
  profile.defaultResumeMode = 'new'
  const line = (type: string, data: object) => JSON.stringify({ type, data }) + '\n'
  const sessionPath = (id: string) => join(directory, 'session-state', id, 'events.jsonl')
  const writeSession = async (id: string, events = ''): Promise<void> => {
    await mkdir(dirname(sessionPath(id)), { recursive: true })
    await writeFile(sessionPath(id), line('session.start', { sessionId: id, startTime: new Date().toISOString() }) + events)
  }

  const host = await h.createMain()
  const hostId = host.activeTabId!
  const hostSessionId = host.tabs.find(tab => tab.id === hostId)!.lastSessionId!
  const hostSpawn = h.spawns[0]!
  await writeSession(hostSessionId, line('user.message', { content: 'Start a review meeting', interactionId: 'host-start' }))
  await writeFile(join(dirname(sessionPath(hostSessionId)), 'inuse.7700.lock'), '')
  h.configureBinding(hostId, 7700, [7700])
  await h.refreshRecords(hostId)
  assert.equal((await h.meetingCommand(hostId, 'start', hostSessionId, 'Initial plan')).ok, true)
  const meetingId = (await h.request('desktop:get-state')).meetings![0]!.id
  await appendFile(sessionPath(hostSessionId),
    line('assistant.turn_start', { turnId: 'host-1' }) +
    line('assistant.message', { interactionId: 'host-start', phase: 'final_answer', content: `Meeting ${meetingId} is open.` }) +
    line('assistant.turn_end', { turnId: 'host-1' }))
  await h.refreshRecords(hostId)
  hostSpawn.emitData('\x1b[?2004h> \r\n <- open sidebar | / commands\r\n')
  await pause(1600)
  await h.pumpMeetingDelivery()
  await pause(2300)

  const reviewer = await h.request('desktop:create-tab', 'new', profile.id)
  const reviewerId = reviewer.activeTabId!
  const reviewerSessionId = reviewer.tabs.find(tab => tab.id === reviewerId)!.lastSessionId!
  const reviewerSpawn = h.spawns[1]!
  await writeSession(reviewerSessionId, line('user.message', { content: `join meeting ${meetingId}`, interactionId: 'rev-join' }))
  await writeFile(join(dirname(sessionPath(reviewerSessionId)), 'inuse.7701.lock'), '')
  h.configureBinding(reviewerId, 7701, [7701])
  await h.refreshRecords(reviewerId)
  assert.equal((await h.meetingCommand(reviewerId, 'join', reviewerSessionId)).ok, true)
  await appendFile(sessionPath(reviewerSessionId),
    line('assistant.turn_start', { turnId: 'rev-join-1' }) +
    line('assistant.message', { interactionId: 'rev-join', phase: 'final_answer', content: 'Joined.' }) +
    line('assistant.turn_end', { turnId: 'rev-join-1' }))
  await h.refreshRecords(reviewerId)
  reviewerSpawn.emitData('\x1b[?2004h> \r\n <- open sidebar | / commands\r\n')
  await pause(1600)
  await h.pumpMeetingDelivery()
  await pause(2300)
  await h.pumpMeetingDelivery()
  await pause(350)
  assert.ok(reviewerSpawn.written.some(chunk => chunk.includes('Initial plan')), 'reviewer received round 1 post')
  h.deferTaskEnter()
  await appendFile(sessionPath(reviewerSessionId),
    line('user.message', { content: `[meeting ${meetingId} · round 1 · from the desktop]\nReview`, interactionId: 'rev-r1' }) +
    line('assistant.turn_start', { turnId: 'rev-r1' }) +
    line('assistant.message', { interactionId: 'rev-r1', phase: 'final_answer', content: 'Four agreed findings.' }) +
    line('assistant.turn_end', { turnId: 'rev-r1' }))
  await h.refreshRecords(reviewerId)
  assert.equal((await h.request('desktop:get-state')).meetings![0]!.stage, 'host', 'meeting moved to host stage')

  // Round-1 digest fails to reach host and becomes uncertain.
  await h.pumpMeetingDelivery()
  h.makeBindingUnreadable(hostId)
  await h.refreshRecords(hostId)
  h.flushTaskEnter()
  const stale = (await h.request('desktop:get-state')).workflowDeliveries?.find(d => d.scope === `meeting/${meetingId}` && d.sessionId === hostSessionId)
  assert.equal(stale?.state, 'uncertain')

  // Host manually retrieves the reply and sends the four agreed findings for a closing vote.
  h.configureBinding(hostId, 7700, [7700])
  await h.refreshRecords(hostId)
  assert.equal((await h.meetingCommand(hostId, 'propose-close', hostSessionId, 'Four agreed findings')).ok, true)
  assert.equal((await h.request('desktop:get-state')).workflowDeliveries?.find(d => d.id === stale!.id)?.state, 'cancelled', 'resolved round-1 digest stops blocking the host')

  // Reviewer votes AGREE on round 2; the closing agreed message must reach the host tab automatically.
  await pause(2100)
  await h.pumpMeetingDelivery()
  h.flushTaskEnter()
  const beforeClose = hostSpawn.written.length
  await appendFile(sessionPath(reviewerSessionId),
    line('user.message', { content: `[meeting ${meetingId} · round 2 · vote · from the desktop]\nVote`, interactionId: 'rev-r2' }) +
    line('assistant.turn_start', { turnId: 'rev-r2' }) +
    line('assistant.message', { interactionId: 'rev-r2', phase: 'final_answer', content: 'AGREE' }) +
    line('assistant.turn_end', { turnId: 'rev-r2' }))
  await h.refreshRecords(reviewerId)

  hostSpawn.emitData('\x1b[?2004h> \r\n <- open sidebar | / commands\r\n')
  await pause(2100)
  await h.pumpMeetingDelivery()
  assert.ok(hostSpawn.written.slice(beforeClose).some(chunk => chunk.includes('All 1 reviewers agreed.')), 'closing vote result reaches the host automatically')
  h.flushTaskEnter()
}))

test('a live conversation turn clears uncertain command state so dialog-like assistant text does not block meeting delivery', async () => fixture(async (h, directory) => {
  const { profile } = configure(h, directory)
  profile.tabs = [{ title: 'Host', lastSessionId: SOURCE }]
  const line = (type: string, data: object) => JSON.stringify({ type, data }) + '\n'
  const log = join(directory, 'session-state', SOURCE, 'events.jsonl')
  await mkdir(dirname(log), { recursive: true })
  await writeFile(log, line('session.start', { sessionId: SOURCE, startTime: new Date().toISOString() }))
  await h.restoreSaved()
  const tab = (await h.request('desktop:get-state')).activeTabId!
  const spawn = h.spawns[0]!
  await writeFile(join(dirname(log), 'inuse.7700.lock'), '')
  h.configureBinding(tab, 7700, [7700])
  await h.refreshRecords(tab)

  // User edits a normal prompt with Left Arrow before pressing Enter, then Copilot replies with text containing dialog hints.
  await h.request('desktop:write-tab', tab, 'start a meeting')
  await h.request('desktop:write-tab', tab, '\x1b[D')
  await h.request('desktop:write-tab', tab, '\r')
  spawn.emitData('\x1b[?2004hPress Esc to cancel if needed.\r\n')
  await appendFile(log,
    line('user.message', { content: 'start a meeting', interactionId: 'u1' }) +
    line('assistant.turn_start', { turnId: 't1' }) +
    line('assistant.message', { interactionId: 'u1', phase: 'final_answer', content: 'Press Esc to cancel if needed.' }) +
    line('assistant.turn_end', { turnId: 't1' }))
  await h.refreshRecords(tab)
  await pause(2100)

  h.queueMeetingDelivery(tab, 'post', 'Reviewer reply digest')
  await h.pumpMeetingDelivery()
  assert.ok(spawn.written.some(chunk => chunk.includes('Reviewer reply digest')), 'meeting delivery is not blocked by a false-positive dialog check')
}))

test('manual host post waits for durable snapshot before cancelling prior digest and preserves recovery across restart if snapshot write fails', async () => fixture(async (h, directory) => {
  const { profile } = configure(h, directory)
  profile.defaultResumeMode = 'new'
  const line = (type: string, data: object) => JSON.stringify({ type, data }) + '\n'
  const sessionPath = (id: string) => join(directory, 'session-state', id, 'events.jsonl')
  const writeSession = async (id: string, events = ''): Promise<void> => {
    await mkdir(dirname(sessionPath(id)), { recursive: true })
    await writeFile(sessionPath(id), line('session.start', { sessionId: id, startTime: new Date().toISOString() }) + events)
  }

  const host = await h.createMain()
  const hostId = host.activeTabId!
  const hostSessionId = host.tabs.find(tab => tab.id === hostId)!.lastSessionId!
  const hostSpawn = h.spawns[0]!
  await writeSession(hostSessionId, line('user.message', { content: 'Start a review meeting', interactionId: 'host-start' }))
  await writeFile(join(dirname(sessionPath(hostSessionId)), 'inuse.7700.lock'), '')
  h.configureBinding(hostId, 7700, [7700])
  await h.refreshRecords(hostId)
  assert.equal((await h.meetingCommand(hostId, 'start', hostSessionId, 'Initial plan')).ok, true)
  const meetingId = (await h.request('desktop:get-state')).meetings![0]!.id
  await appendFile(sessionPath(hostSessionId),
    line('assistant.turn_start', { turnId: 'host-1' }) +
    line('assistant.message', { interactionId: 'host-start', phase: 'final_answer', content: `Meeting ${meetingId} is open.` }) +
    line('assistant.turn_end', { turnId: 'host-1' }))
  await h.refreshRecords(hostId)
  hostSpawn.emitData('\x1b[?2004h> \r\n <- open sidebar | / commands\r\n')
  await pause(1600)
  await h.pumpMeetingDelivery()
  await pause(2300)

  const reviewer = await h.request('desktop:create-tab', 'new', profile.id)
  const reviewerId = reviewer.activeTabId!
  const reviewerSessionId = reviewer.tabs.find(tab => tab.id === reviewerId)!.lastSessionId!
  const reviewerSpawn = h.spawns[1]!
  await writeSession(reviewerSessionId, line('user.message', { content: `join meeting ${meetingId}`, interactionId: 'rev-join' }))
  await writeFile(join(dirname(sessionPath(reviewerSessionId)), 'inuse.7701.lock'), '')
  h.configureBinding(reviewerId, 7701, [7701])
  await h.refreshRecords(reviewerId)
  assert.equal((await h.meetingCommand(reviewerId, 'join', reviewerSessionId)).ok, true)
  await appendFile(sessionPath(reviewerSessionId),
    line('assistant.turn_start', { turnId: 'rev-join-1' }) +
    line('assistant.message', { interactionId: 'rev-join', phase: 'final_answer', content: 'Joined.' }) +
    line('assistant.turn_end', { turnId: 'rev-join-1' }))
  await h.refreshRecords(reviewerId)
  reviewerSpawn.emitData('\x1b[?2004h> \r\n <- open sidebar | / commands\r\n')
  await pause(1600)
  await h.pumpMeetingDelivery()
  await pause(2300)
  await h.pumpMeetingDelivery()
  await pause(350)
  assert.ok(reviewerSpawn.written.some(chunk => chunk.includes('Initial plan')), 'reviewer received round 1 post')

  // Round-1 digest fails to reach host and becomes uncertain; ensure the round-1 snapshot is on disk.
  h.deferTaskEnter()
  await appendFile(sessionPath(reviewerSessionId),
    line('user.message', { content: `[meeting ${meetingId} · round 1 · from the desktop]\nReview`, interactionId: 'rev-r1' }) +
    line('assistant.turn_start', { turnId: 'rev-r1' }) +
    line('assistant.message', { interactionId: 'rev-r1', phase: 'final_answer', content: 'Four agreed findings.' }) +
    line('assistant.turn_end', { turnId: 'rev-r1' }))
  await h.refreshRecords(reviewerId)
  await h.pumpMeetingDelivery()
  h.makeBindingUnreadable(hostId)
  await h.refreshRecords(hostId)
  h.flushTaskEnter()
  await h.flushMeetingWrites(meetingId)
  const stale = (await h.request('desktop:get-state')).workflowDeliveries?.find(d => d.scope === `meeting/${meetingId}` && d.sessionId === hostSessionId)
  assert.equal(stale?.state, 'uncertain')

  // Defer the round-2 meeting.json write, verify the prior digest is not cancelled while the write is pending,
  // then fail the snapshot write and verify the prior digest stays uncertain for restart recovery.
  h.configureBinding(hostId, 7700, [7700])
  await h.refreshRecords(hostId)
  let snapshotStarted!: () => void
  const started = new Promise<void>(resolve => { snapshotStarted = resolve })
  let rejectSnapshot!: (error: Error) => void
  const deferredSnapshot = new Promise<void>((_resolve, reject) => { rejectSnapshot = reject })
  h.holdMeetingWrite(path => path.endsWith('meeting.json'), () => deferredSnapshot, snapshotStarted)

  const post = h.meetingCommand(hostId, 'propose-close', hostSessionId, 'Four agreed findings')
  await started
  assert.equal(
    (await h.request('desktop:get-state')).workflowDeliveries?.find(d => d.id === stale!.id)?.state,
    'uncertain',
    'prior host digest stays uncancelled until the new round snapshot lands on disk',
  )
  rejectSnapshot(new Error('ENOSPC: snapshot write failed'))
  assert.equal((await post).ok, true)
  assert.equal(
    (await h.request('desktop:get-state')).workflowDeliveries?.find(d => d.id === stale!.id)?.state,
    'uncertain',
    'failed snapshot write preserves uncertain host handoff for restart recovery',
  )

  // Verify the restart boundary: shut down the first instance and restore from the on-disk snapshot + SQLite journal.
  const meetingFolder = join(directory, 'meetings', meetingId)
  const saved = JSON.parse(await readFile(join(meetingFolder, 'meeting.json'), 'utf8'))
  assert.equal(saved.stage, 'host', 'on-disk snapshot remains on the old host round')
  assert.equal(saved.round, 1)
  const transcript = await readFile(join(meetingFolder, 'transcript.md'), 'utf8')
  await h.cleanup()

  const { WorkflowDeliveries } = await import('./workflow-deliveries.js')
  const { journalMeetingDelivery } = await import('./workflow-meeting-journal.js')
  const { MeetingHub } = await import('./meeting.js')
  const { MeetingOutbox } = await import('./meeting-delivery.js')
  const restoredJournal = new WorkflowDeliveries(join(directory, 'workflow-deliveries.sqlite'))
  try {
    let clock = 0
    const typed: Array<{ tabId: string; text: string }> = []
    const sessionsByTab: Record<string, string> = { host: hostSessionId, reviewer: reviewerSessionId }
    const outbox = new MeetingOutbox({
      settled: (tabId, delivery) => {
        if (hub.superseded(tabId, delivery)) return true
        if (delivery.kind === 'add-dir') return false
        const item = journalMeetingDelivery(restoredJournal, sessionsByTab[tabId]!, delivery)
        return item !== null && ['answered', 'cancelled'].includes(item.state)
      },
      sendTask: (tabId, text, delivery) => {
        const item = journalMeetingDelivery(restoredJournal, sessionsByTab[tabId]!, delivery)
        if (!item || item.state !== 'queued') return { result: 'busy', message: 'waiting for reconciliation' }
        restoredJournal.begin(item.id, () => true)
        typed.push({ tabId, text })
        return { result: 'sent' }
      },
      sendCommand: () => true,
      sent: () => {},
      refused: () => {},
      now: () => clock,
    })
    const hub = new MeetingHub(() => join(directory, 'meetings'), {
      deliver: (tabId, delivery) => outbox.enqueue(tabId, delivery),
      cancel: (id, tabId) => outbox.cancel(id, tabId),
      write: () => {},
      changed: () => {},
      notify: () => {},
      sessionIdOf: tabId => sessionsByTab[tabId] ?? null,
    }, () => ({ maxRounds: 6, roundTimeoutMinutes: 10 }))

    hub.restore(saved, transcript, sessionId => sessionId === hostSessionId
      ? { tabId: 'host', title: 'Host', folder: directory }
      : sessionId === reviewerSessionId ? { tabId: 'reviewer', title: 'Reviewer', folder: directory } : null)
    assert.equal(hub.views()[0]?.stage, 'host')
    assert.equal(hub.views()[0]?.round, 1)

    // Let /add-dir settle, then pump the restored digest: it must stay queued for recovery, not be dropped as cancelled.
    outbox.pump()
    clock += 2_000
    outbox.pump()
    assert.equal(restoredJournal.get(stale!.id)?.state, 'uncertain')
    assert.equal(typed.length, 0)
    assert.equal(outbox.next('host')?.kind, 'digest', 'restored digest stays available in the outbox instead of being dropped')

    // Retrying from Handoffs after restart delivers the round-1 digest cleanly.
    restoredJournal.retry(stale!.id)
    outbox.pump()
    assert.equal(typed.length, 1)
    assert.ok(typed[0]!.text.includes('Four agreed findings.'), 'retried host digest is delivered after restart')
  } finally {
    restoredJournal.close()
  }
}))

test('restoring a meeting whose new-round snapshot landed before journal settlement retires only the superseded host digest', async () => fixture(async (h, directory) => {
  const line = (type: string, data: object) => JSON.stringify({ type, data }) + '\n'
  const sessionPath = (id: string) => join(directory, 'session-state', id, 'events.jsonl')
  for (const [id, pid] of [[SOURCE, 7700], [FORK, 7701]] as const) {
    await mkdir(dirname(sessionPath(id)), { recursive: true })
    await writeFile(sessionPath(id), line('session.start', { sessionId: id, startTime: new Date().toISOString() }))
    await writeFile(join(dirname(sessionPath(id)), `inuse.${pid}.lock`), '')
  }

  // Simulate process exit right after the round-2 propose-close snapshot landed on disk, before settleHostDelivery ran.
  const meetingId = 'RZFW'
  const meetingFolder = join(directory, 'meetings', meetingId)
  await mkdir(join(meetingFolder, 'round-2'), { recursive: true })
  await writeFile(join(meetingFolder, 'transcript.md'), `# Meeting ${meetingId}\n`)
  await writeFile(join(meetingFolder, 'round-2', 'post.md'), 'Four agreed findings\n')
  const voteDeliveryId = '33333333-3333-4333-8333-333333333333'
  const staleDigestId = '44444444-4444-4444-8444-444444444444'
  await writeFile(join(meetingFolder, 'meeting.json'), JSON.stringify({
    version: 1,
    id: meetingId,
    topic: 'Test proposal',
    host: { sessionId: SOURCE, title: 'Host', folder: directory, role: null, counted: { nanoAiu: 0, premiumRequests: 0 } },
    participants: [{
      sessionId: FORK, title: 'Reviewer', folder: directory, role: null, counted: { nanoAiu: 0, premiumRequests: 0 },
      joinedRound: 1, reply: null, awaited: true, missed: 0,
    }],
    stage: 'reviewing',
    round: 2,
    maxRounds: 6,
    vote: true,
    post: 'Four agreed findings',
    hasChanges: false,
    late: [],
    discussing: false,
    reviewed: null,
    held: null,
    pauseReason: null,
    remindedHost: false,
    outcome: null,
    cost: { nanoAiu: 0, premiumRequests: 0 },
    outstanding: [{
      sessionId: FORK,
      delivery: {
        meetingId,
        round: 2,
        kind: 'vote',
        text: `[meeting ${meetingId} · round 2 · vote · from the desktop]\nFour agreed findings`,
        id: voteDeliveryId,
      },
    }],
  }))

  const { WorkflowDeliveries } = await import('./workflow-deliveries.js')
  const { journalMeetingDelivery } = await import('./workflow-meeting-journal.js')
  const preCrashJournal = new WorkflowDeliveries(join(directory, 'workflow-deliveries.sqlite'))
  let staleRowId: string
  let otherMeetingRowId: string
  try {
    const staleRow = journalMeetingDelivery(preCrashJournal, SOURCE, { meetingId, round: 1, kind: 'digest', text: 'R1 replies', id: staleDigestId })!
    preCrashJournal.begin(staleRow.id, () => true)
    preCrashJournal.submitted(staleRow.id)
    preCrashJournal.uncertain(staleRow.id)
    staleRowId = staleRow.id

    // An unrelated non-meeting uncertain handoff for the reviewer session must not be touched by RZFW's restore.
    const otherRow = preCrashJournal.enqueue({ sessionId: FORK, source: 'github/1', revision: 'v1', scope: 'grant-1', text: 'Unrelated handoff' })
    preCrashJournal.begin(otherRow.id, () => true)
    preCrashJournal.uncertain(otherRow.id)
    otherMeetingRowId = otherRow.id
  } finally {
    preCrashJournal.close()
  }

  // Configure and restore the new app instance over the pre-crash SQLite journal and round-2 snapshot.
  const { profile } = configure(h, directory)
  profile.tabs = [
    { title: 'Host', lastSessionId: SOURCE, active: true },
    { title: 'Reviewer', lastSessionId: FORK },
  ]
  await h.restoreSaved()
  const state = await h.request('desktop:get-state')
  assert.equal(state.workflowDeliveries?.find(d => d.id === staleRowId)?.state, 'cancelled', 'superseded round-1 host digest is retired on restore')
  assert.equal(state.workflowDeliveries?.find(d => d.id === otherMeetingRowId)?.state, 'uncertain', 'unrelated uncertain handoff stays untouched')

  const hostTab = state.tabs.find(tab => tab.lastSessionId === SOURCE)!
  const reviewerTab = state.tabs.find(tab => tab.lastSessionId === FORK)!
  // Wait for both restored tabs' PTY spawns to start.
  await waitFor(async () => h.spawns.length, n => n === 2, 'both restored tabs started')
  const hostSpawn = h.spawns[0]!
  const reviewerSpawn = h.spawns[1]!
  h.configureBinding(hostTab.id, 7700, [7700])
  h.configureBinding(reviewerTab.id, 7701, [7701])
  await h.refreshRecords(hostTab.id)
  await h.refreshRecords(reviewerTab.id)
  hostSpawn.emitData('\x1b[?2004h> \r\n <- open sidebar | / commands\r\n')
  reviewerSpawn.emitData('\x1b[?2004h> \r\n <- open sidebar | / commands\r\n')
  await pause(1600)
  // Pump /add-dir for the unblocked host tab, then unblock FORK's unrelated handoff so FORK receives /add-dir and its round-2 vote.
  await h.pumpMeetingDelivery()
  await pause(2300)
  await h.request('desktop:delivery-action', otherMeetingRowId, 'discard')
  await h.pumpMeetingDelivery()
  await pause(2300)
  await h.pumpMeetingDelivery()
  await pause(350)
  assert.ok(reviewerSpawn.written.some(chunk => chunk.includes('Four agreed findings')), 'reviewer received restored round-2 vote')

  const beforeClose = hostSpawn.written.length
  await appendFile(sessionPath(FORK),
    line('user.message', { content: `[meeting ${meetingId} · round 2 · vote · from the desktop]\nFour agreed findings`, interactionId: 'rev-r2' }) +
    line('assistant.turn_start', { turnId: 'rev-r2' }) +
    line('assistant.message', { interactionId: 'rev-r2', phase: 'final_answer', content: 'AGREE' }) +
    line('assistant.turn_end', { turnId: 'rev-r2' }))
  await h.refreshRecords(reviewerTab.id)
  await h.pumpMeetingDelivery()
  assert.ok(hostSpawn.written.slice(beforeClose).some(chunk => chunk.includes('All 1 reviewers agreed.')), 'closing agreed message reaches host automatically without being blocked by superseded round-1 digest')
}))

test('an overlapping pumpMeetingOutbox call coalesces and delivers work queued while the first pass is awaiting prepareMeetingDelivery', async () => fixture(async (h, directory) => {
  const { profile } = configure(h, directory)
  profile.defaultResumeMode = 'new'
  const line = (type: string, data: object) => JSON.stringify({ type, data }) + '\n'
  const sessionPath = (id: string) => join(directory, 'session-state', id, 'events.jsonl')
  const firstState = await h.createMain()
  const first = firstState.activeTabId!
  const firstSessionId = firstState.tabs.find(tab => tab.id === first)!.lastSessionId!
  const secondState = await h.request('desktop:create-tab', 'new', profile.id)
  const second = secondState.activeTabId!
  const secondSessionId = secondState.tabs.find(tab => tab.id === second)!.lastSessionId!
  const firstSpawn = h.spawns[0]!
  const secondSpawn = h.spawns[1]!

  for (const [tabId, sessionId, pid, spawn] of [
    [first, firstSessionId, 7710, firstSpawn],
    [second, secondSessionId, 7711, secondSpawn],
  ] as const) {
    await mkdir(dirname(sessionPath(sessionId)), { recursive: true })
    await writeFile(sessionPath(sessionId), line('session.start', { sessionId, startTime: new Date().toISOString() }))
    await writeFile(join(dirname(sessionPath(sessionId)), `inuse.${pid}.lock`), '')
    h.configureBinding(tabId, pid, [pid])
    await h.refreshRecords(tabId)
    spawn.emitData('\x1b[?2004h> \r\n <- open sidebar | / commands\r\n')
  }
  await pause(1600)

  // Hold the first pump inside first's prepareMeetingDelivery() after pass 1 has already captured readyTabs().
  const reader = h.bindingReader(first)
  const originalRead = reader.read.bind(reader)
  let readStarted!: () => void
  const started = new Promise<void>(resolve => { readStarted = resolve })
  let releaseRead!: () => void
  const gate = new Promise<void>(resolve => { releaseRead = resolve })
  reader.read = async (...args) => {
    readStarted()
    await gate
    reader.read = originalRead
    return originalRead(...args)
  }

  h.queueMeetingDelivery(first, 'post', 'First tab delivery')
  const firstPump = h.pumpMeetingDelivery()
  await started

  // Queue work for the second tab and start an overlapping pump while pass 1 is still suspended.
  h.queueMeetingDelivery(second, 'post', 'Second tab delivery queued mid-pump')
  const secondPump = h.pumpMeetingDelivery()
  releaseRead()
  await Promise.all([firstPump, secondPump])

  assert.ok(firstSpawn.written.some(chunk => chunk.includes('First tab delivery')), 'first pass delivered to the first tab')
  assert.ok(secondSpawn.written.some(chunk => chunk.includes('Second tab delivery queued mid-pump')), 'overlapping pump coalesced and delivered mid-pump work without a third pump')
}))

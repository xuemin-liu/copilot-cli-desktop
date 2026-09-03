import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'
import { build } from 'esbuild'
import { createWorkspaceProfile, DEFAULT_DESKTOP_CONFIG, type DesktopConfig } from './desktop-config.js'
import { EMPTY_COPILOT_CAPABILITIES, type CopilotCapabilities } from './copilot-command.js'
import type { DesktopState, WorkspaceProfile } from './types.js'

const SOURCE = '11111111-1111-4111-8111-111111111111'
const FORK = '22222222-2222-4222-8222-222222222222'
interface Harness {
  configure(config: DesktopConfig, capabilities: CopilotCapabilities): void
  createMain(): Promise<DesktopState>
  createSide(profile: WorkspaceProfile, parentId: string): Promise<DesktopState>
  restore(): Promise<void>
  beginQuit(): void
  request(name: string, ...args: unknown[]): Promise<DesktopState>
  cleanup(): Promise<void>
  spawns: { args: string[]; env: NodeJS.ProcessEnv; stopped: boolean }[]
}

/** Exercise the unchanged main.ts lifecycle functions and registered IPC
 * handlers with real launch planning and PtySession. Only Electron's OS shell
 * and the native PTY boundary are replaced. Test-only exports are appended to
 * a disposable bundle, never exposed in the shipped application.
 */
async function fixture(action: (harness: Harness, directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'desktop-lifecycle-unit-'))
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
      './node-pty-backend.js': `
        export const spawns = [];
        export async function spawnNodePty(file, args, options) {
          const exits = new Set();
          const record = { args, env: options.env, stopped: false };
          spawns.push(record);
          return { pid: undefined, onData() {}, onExit(fn) { exits.add(fn); }, write() {}, resize() {},
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
        import { spawns } from './node-pty-backend.js';
        export const lifecycleTest = {
          spawns,
          configure(config, capabilities) { desktopConfig = config; copilotCapabilities = capabilities;
            state.resolution = { kind: 'direct', command: 'inert-pty', prefixArgs: [], resolvedPath: null, version: '1.0.82', error: null, pathAdditions: ['C:/Program Files/nodejs'] }; syncWorkspaceState(); },
          createMain: () => createSessionTab(),
          createSide: (profile, parentId) => createSessionTab(profile, 'auto-resume', '${FORK}', [], null, 'Side', { sideChat: true, sideParentTabId: parentId }),
          restore: restoreTabsForActiveProfile,
          beginQuit: () => app.emit('before-quit', { preventDefault() {} }),
          request: (name, ...args) => ipcMain.invoke(name, { senderFrame: { url: shellUrl() } }, ...args),
          async cleanup() { await stopAllSessions(); await configWriteQueue; },
        };
      `, resolveDir: dirname(mainPath), loader: 'js' },
      bundle: true, platform: 'node', format: 'esm', packages: 'external', write: false,
      plugins: [{ name: 'inert-os-boundaries', setup(builder) {
        builder.onResolve({ filter: /^(electron|electron-updater|\.\/(node-pty-backend|resolve-copilot)\.js)$/ }, (args) => ({ path: args.path, namespace: 'test-boundary' }))
        builder.onLoad({ filter: /.*/, namespace: 'test-boundary' }, (args) => ({ contents: mocks[args.path]!, loader: 'js' }))
      } }],
    })
    const bundlePath = join(directory, 'main-harness.mjs')
    await writeFile(bundlePath, bundle.outputFiles[0]!.contents)
    harness = (await import(pathToFileURL(bundlePath).href)).lifecycleTest as Harness
    await action(harness, directory)
  } finally {
    await harness?.cleanup()
    await rm(directory, { recursive: true, force: true })
  }
}

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
    assert.equal(restarted.tabs.find((tab) => tab.id === sideId)?.launchedPermissionPreset, 'read-only')
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
    assert.ok(harness.spawns[0]!.args.includes('--allow-all'))
    assertRestricted(harness.spawns[1]!.args)
    assert.equal(state.tabs[1]!.sideParentTabId, state.tabs[0]!.id)
    assert.equal(state.tabs[1]!.launchedPermissionPreset, 'read-only')
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

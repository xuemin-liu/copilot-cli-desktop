// Tabs that run another CLI, in the real app: the real main process, the real new-session dialog, and the Claude Code and
// Codex CLIs installed on this computer, each with an empty home of its own (CLAUDE_CONFIG_DIR, CODEX_HOME) so nothing of
// the person's sign-in, settings or session lists is read or changed. Without a sign-in neither CLI can take a prompt, so
// "the CLI stored the session" is staged by writing the file each one would write; what the desktop then starts is read
// from the real processes' command lines. Antigravity uses Node's REPL as a local agy executable fixture.
// Skips when either Claude Code or Codex CLI is not installed.
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath, pathToFileURL } from 'node:url'

const artifacts = resolve('test-results/other-cli-tabs')
const delay = ms => new Promise(accept => setTimeout(accept, ms))

if (!process.versions.electron) {
  await mkdir(artifacts, { recursive: true })
  await writeFile(join(artifacts, 'result.json'), JSON.stringify({ passed: false }))
  const base = process.env.CHECK_TMP ?? tmpdir()
  await mkdir(base, { recursive: true })
  const directory = await mkdtemp(join(base, 'other-cli-tabs-'))
  let timer
  try {
    const bin = join(directory, 'bin')
    await mkdir(bin)
    const agy = join(bin, process.platform === 'win32' ? 'agy.exe' : 'agy')
    const pathKey = Object.keys(process.env).find(key => key.toUpperCase() === 'PATH') ?? 'PATH'
    const env = { ...process.env, CLI_DIR: directory, CLI_ARTIFACTS: artifacts, COPILOT_DESKTOP_MEETING_MCP_PORT: '0',
      ANTIGRAVITY_GEMINI_DIR: join(directory, 'gemini-home'), [pathKey]: [bin, process.env[pathKey]].filter(Boolean).join(delimiter) }
    delete env.ELECTRON_RUN_AS_NODE
    delete env.SHELL // Keep the fixture first when Electron constructs its POSIX PATH.
    if (process.platform === 'win32') await copyFile(process.execPath, agy)
    else await symlink(process.execPath, agy)
    const child = spawn((await import('electron')).default, [fileURLToPath(import.meta.url)], { env, stdio: 'inherit', windowsHide: true })
    timer = setTimeout(() => child.kill(), 240_000)
    const code = await new Promise((accept, reject) => { child.once('error', reject); child.once('exit', accept) })
    assert.equal(code, 0, 'Other CLI tabs check failed')
    const result = JSON.parse(await readFile(join(artifacts, 'result.json'), 'utf8'))
    assert.equal(result.passed, true)
    console.log(result.skipped
      ? `Skipped: ${result.skipped}`
      : 'Claude Code, Codex CLI and the Antigravity fixture launch, save and restart in their own session tabs.')
  } finally {
    clearTimeout(timer)
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }).catch(() => {})
  }
} else {
  const { app, BrowserWindow } = await import('electron')
  const directory = process.env.CLI_DIR
  const out = process.env.CLI_ARTIFACTS
  const userData = join(directory, 'userdata')
  app.setPath('userData', userData)
  void run().catch(async error => {
    console.error(error)
    await writeFile(join(out, 'result.json'), JSON.stringify({ passed: false, error: String(error) })).catch(() => {})
    app.exit(1)
  })

  async function run() {
    for (const name of ['copilot-home', 'claude-home', 'codex-home', 'userdata']) await mkdir(join(directory, name), { recursive: true })
    await writeFile(join(directory, 'gitconfig'), '[user]\n\tname = Check\n\temail = check@example.com\n[init]\n\tdefaultBranch = main\n')
    process.env.GIT_CONFIG_NOSYSTEM = '1'
    process.env.GIT_CONFIG_GLOBAL = join(directory, 'gitconfig')
    process.env.COPILOT_HOME = join(directory, 'copilot-home')
    process.env.COPILOT_DISABLE_KEYTAR = '1'
    process.env.CLAUDE_CONFIG_DIR = join(directory, 'claude-home')
    process.env.CODEX_HOME = join(directory, 'codex-home')
    await writeFile(join(directory, 'copilot-home', 'config.json'), JSON.stringify({ trustedFolders: [directory] }))
    const repo = join(directory, 'project')
    await mkdir(repo, { recursive: true })
    const git = (...args) => execFileSync('git', args, { cwd: repo, env: process.env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    git('init', '-q')
    await writeFile(join(repo, 'a.txt'), 'project\n')
    git('add', '.')
    git('commit', '-q', '-m', 'init')

    const { resolveAgentCli } = await import('../dist/src/main/agent-cli.js')
    const installed = { claude: await resolveAgentCli('claude'), codex: await resolveAgentCli('codex'), antigravity: await resolveAgentCli('antigravity') }
    assert.equal(installed.antigravity.error, null)
    assert.equal(installed.antigravity.command, join(directory, 'bin', process.platform === 'win32' ? 'agy.exe' : 'agy'))
    const missing = Object.values(installed).filter(found => found.version === null).map(found => found.cli)
    if (missing.length > 0) {
      await writeFile(join(out, 'result.json'), JSON.stringify({ passed: true, skipped: `not installed: ${missing.join(', ')}` }))
      app.exit(0)
      return
    }

    const { createWorkspaceProfile, DEFAULT_DESKTOP_CONFIG, readDesktopConfig, writeDesktopConfig } = await import('../dist/src/main/desktop-config.js')
    const project = createWorkspaceProfile(repo)
    project.defaultResumeMode = 'new'
    await writeDesktopConfig(join(userData, 'desktop.json'), { ...DEFAULT_DESKTOP_CONFIG, profiles: [project], activeProfileId: project.id,
      closeBehavior: 'quit', trayEnabled: false, notifications: false, automaticUpdateChecks: false })
    await import('../dist/src/main/main.js')
    await app.whenReady()
    let main
    for (let attempt = 0; attempt < 150 && !main; attempt++) {
      main = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('index.html'))
      if (!main) await delay(100)
    }
    assert.ok(main, 'main window did not load')
    main.setContentSize(1500, 900)
    const ui = code => main.webContents.executeJavaScript(code)
    const until = async (code, label, timeout = 30_000) => {
      const end = Date.now() + timeout
      while (Date.now() < end) { if (await ui(code)) return; await delay(100) }
      throw new Error(`Timed out: ${label}\n--- page text ---\n${(await ui('document.body.innerText.slice(0, 800)')).trim()}`)
    }
    const click = async selector => {
      const point = await ui(`(() => {
        const element = [...document.querySelectorAll(${JSON.stringify(selector)})].find(candidate => candidate.getClientRects().length > 0);
        if (!element) throw new Error('Missing click target: ' + ${JSON.stringify(selector)});
        const rect = element.getBoundingClientRect();
        return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
      })()`)
      main.webContents.sendInputEvent({ type: 'mouseMove', ...point })
      main.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point })
      main.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point })
    }
    const press = keyCode => {
      main.webContents.sendInputEvent({ type: 'keyDown', keyCode })
      if (keyCode === 'Return') main.webContents.sendInputEvent({ type: 'char', keyCode: '\r' })
      main.webContents.sendInputEvent({ type: 'keyUp', keyCode })
    }
    const type = text => { for (const keyCode of text) main.webContents.sendInputEvent({ type: 'char', keyCode }) }
    // A native list cannot be driven by mouse events: choose the way picking in it does.
    const chooseCli = value => ui(`(() => {
      const select = document.querySelector('select[name="cli"]');
      select.value = ${JSON.stringify(value)};
      select.dispatchEvent(new Event('change', { bubbles: true }));
    })()`)
    const tabs = async () => (await ui('window.copilotDesktop.getState()')).tabs
    const tabWhere = async (predicate, label, timeout = 30_000) => {
      const end = Date.now() + timeout
      while (Date.now() < end) {
        const found = (await tabs()).find(predicate)
        if (found) return found
        await delay(150)
      }
      throw new Error(`Timed out: ${label}\n${JSON.stringify(await tabs(), null, 1)}`)
    }
    /** The command line of a running process, as Windows or ps reports it; null once it has gone. */
    const commandLine = pid => {
      try {
        return process.platform === 'win32'
          ? execFileSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
              ['-NoProfile', '-NonInteractive', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}").CommandLine`], { encoding: 'utf8', windowsHide: true }).trim() || null
          : execFileSync('ps', ['-o', 'args=', '-p', String(Number(pid))], { encoding: 'utf8' }).trim() || null
      } catch { return null }
    }
    const savedTabs = async () => JSON.parse(await readFile(join(userData, 'desktop.json'), 'utf8')).profiles[0].tabs
    const untilSaved = async (predicate, label) => {
      const end = Date.now() + 15_000
      while (Date.now() < end) { const saved = await savedTabs(); if (predicate(saved)) return saved; await delay(200) }
      throw new Error(`Timed out: ${label}\n${JSON.stringify(await savedTabs(), null, 1)}`)
    }
    const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    const results = { versions: { claude: installed.claude.version, codex: installed.codex.version, antigravityFixture: installed.antigravity.version } }

    await until('!!document.querySelector(".session-git-toggle") && !!document.querySelector(".xterm")', 'first session', 60_000)

    // The dialog offers the installed CLI versions. Copilot stays the default.
    await click(`[aria-label="New session in ${project.name}"]`)
    await until('!!document.querySelector(".input-dialog select[name=\\"cli\\"]")', 'dialog with the CLI list')
    await until(`[...document.querySelectorAll('select[name="cli"] option')].some(option => /^Claude Code \\d/.test(option.innerText))`, 'the installed CLIs are listed with versions', 60_000)
    const offered = await ui(`({ value: document.querySelector('select[name="cli"]').value, options: [...document.querySelectorAll('select[name="cli"] option')].map(option => option.innerText.trim()) })`)
    assert.equal(offered.value, 'copilot')
    assert.deepEqual(offered.options, ['Copilot CLI', `Claude Code ${installed.claude.version}`, `Codex CLI ${installed.codex.version}`, `Antigravity CLI ${installed.antigravity.version}`])

    // Claude Code: the dialog says what the tab is, and a new worktree is not offered for it.
    await chooseCli('claude')
    await until(`/Claude Code itself/.test(document.querySelector('.input-dialog .fork-hint')?.innerText ?? '')`, 'hint for Claude Code')
    const claudeDialog = await ui(`({ placeholder: document.querySelector('#input-dialog-value').placeholder,
      newWorktreeDisabled: document.querySelector('select[name="start-in"] option[value="new"]').disabled,
      startIn: document.querySelector('select[name="start-in"]').value })`)
    assert.deepEqual(claudeDialog, { placeholder: 'Claude Code', newWorktreeDisabled: true, startIn: 'folder' })
    await delay(400)
    await writeFile(join(out, 'dialog-claude.png'), (await main.webContents.capturePage()).toPNG())
    press('Return')
    let claude = await tabWhere(tab => tab.cli === 'claude' && tab.status === 'running' && tab.processId && tab.sessionCwd, 'the Claude Code tab runs')
    assert.equal(claude.title, 'Claude Code')
    assert.match(claude.lastSessionId, UUID, 'the desktop named the Claude Code session')
    assert.equal(claude.sessionPermissionPreset, null, 'no Copilot permission preset applies to it')
    assert.equal(claude.cliVersion, installed.claude.version)
    assert.equal(claude.sessionCwd.toLowerCase(), repo.toLowerCase())
    let line = commandLine(claude.processId)
    assert.ok(line, 'the Claude Code process is running')
    assert.match(line.toLowerCase(), /claude/)
    assert.ok(line.includes(`--session-id ${claude.lastSessionId}`), `a new session is started under the tab's id: ${line}`)
    assert.doesNotMatch(line, /--allow-tool|--deny-tool|--mouse|--name/, 'none of Copilot\'s flags reach it')
    results.claudeStarted = line

    // Codex CLI, named in the dialog.
    await click(`[aria-label="New session in ${project.name}"]`)
    await until('!!document.querySelector(".input-dialog select[name=\\"cli\\"]")', 'dialog for Codex')
    await chooseCli('codex')
    await until(`/Codex CLI itself/.test(document.querySelector('.input-dialog .fork-hint')?.innerText ?? '')`, 'hint for Codex')
    type('Codex work')
    press('Return')
    let codex = await tabWhere(tab => tab.cli === 'codex' && tab.status === 'running' && tab.processId, 'the Codex tab runs')
    assert.equal(codex.title, 'Codex work')
    assert.equal(codex.lastSessionId, null, 'Codex names its own session, so the tab has no id yet')
    line = commandLine(codex.processId)
    assert.ok(line, 'the Codex process is running')
    assert.match(line.toLowerCase(), /codex/)
    assert.doesNotMatch(line, /\bresume\b|--session-id/, `a new Codex session takes no id: ${line}`)
    results.codexStarted = line

    // Both terminals show their program's own screen.
    await until(`document.querySelectorAll('.session-cli-chip').length >= 2`, 'the CLI chips')
    await delay(4_000)
    await writeFile(join(out, 'codex-tab.png'), (await main.webContents.capturePage()).toPNG())
    await ui(`window.copilotDesktop.activateTab(${JSON.stringify(claude.id)})`)
    await delay(1_500)
    await writeFile(join(out, 'claude-tab.png'), (await main.webContents.capturePage()).toPNG())
    assert.match(await ui('document.querySelector(".sidebar-access")?.innerText ?? ""'), /Access set in Claude Code/)

    // Codex stores the session (staged: its file appears, saying it runs in the project folder) and the tab takes its id.
    const codexId = '0199aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee'
    const day = new Date()
    const dayFolder = join(process.env.CODEX_HOME, 'sessions', String(day.getFullYear()), String(day.getMonth() + 1).padStart(2, '0'), String(day.getDate()).padStart(2, '0'))
    await mkdir(dayFolder, { recursive: true })
    await writeFile(join(dayFolder, `rollout-2026-01-01T00-00-00-${codexId}.jsonl`), `${JSON.stringify({ timestamp: day.toISOString(), type: 'session_meta', payload: { id: codexId, cwd: repo } })}\n`)
    codex = await tabWhere(tab => tab.cli === 'codex' && tab.lastSessionId === codexId, 'the Codex tab takes the id of the session Codex stored')
    results.codexSessionFound = codexId

    await click(`[aria-label="New session in ${project.name}"]`)
    await until('!!document.querySelector(".input-dialog select[name=\\"cli\\"]")', 'dialog for Antigravity')
    await chooseCli('antigravity')
    await until(`/Antigravity CLI itself/.test(document.querySelector('.input-dialog .fork-hint')?.innerText ?? '')`, 'hint for Antigravity')
    press('Return')
    let antigravity = await tabWhere(tab => tab.cli === 'antigravity' && tab.status === 'running' && tab.processId && tab.sessionCwd, 'the Antigravity tab runs')
    assert.equal(antigravity.cliVersion, installed.antigravity.version)
    assert.equal(antigravity.sessionCwd.toLowerCase(), repo.toLowerCase())
    assert.equal(antigravity.lastSessionId, null)
    line = commandLine(antigravity.processId)
    assert.match(line ?? '', /[\\/]agy(?:\.exe)?"?\s*$/i, 'Antigravity starts without CLI arguments')
    const mcpUrl = await ui('window.copilotDesktop.getState().then(state => state.meetingToolsUrl)')
    assert.match(mcpUrl, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/)
    const mcpConfig = join(process.env.ANTIGRAVITY_GEMINI_DIR, 'config', 'mcp_config.json')
    const { mcpServers } = JSON.parse(await readFile(mcpConfig, 'utf8'))
    const installedMcp = mcpServers['copilot-meeting'].serverUrl
    assert.equal(installedMcp, `${mcpUrl}?source=copilot-cli-desktop`, 'The desktop registered its listening endpoint before launch')
    results.antigravityStarted = line

    const saved = await untilSaved(list => list.some(tab => tab.cli === 'codex' && tab.lastSessionId === codexId) && list.some(tab => tab.cli === 'antigravity'), 'the CLI tabs are saved')
    assert.deepEqual(saved.map(tab => [tab.cli ?? 'copilot', tab.title]), [['copilot', 'project'], ['claude', 'Claude Code'], ['codex', 'Codex work'], ['antigravity', 'Antigravity CLI']])
    assert.equal(saved.find(tab => tab.cli === 'claude').lastSessionId, claude.lastSessionId)
    assert.equal(saved.find(tab => tab.cli === 'claude').sessionPermissionPreset, undefined)
    assert.equal((await readDesktopConfig(join(userData, 'desktop.json'))).profiles[0].tabs.find(tab => tab.cli === 'antigravity')?.lastSessionId, null)

    // A rename changes the tab's title and waits for nothing: there is no Copilot session to rename.
    await ui(`window.copilotDesktop.renameTab(${JSON.stringify(claude.id)}, 'Review with Claude')`)
    claude = await tabWhere(tab => tab.id === claude.id && tab.title === 'Review with Claude', 'the Claude Code tab is renamed')
    assert.equal(claude.renamePending, undefined)

    // Tasks track Copilot sessions: the Tasks list offers only the Copilot tab, and main refuses the others outright.
    await click('.sidebar details summary, [aria-label*="Tasks"]').catch(() => {})
    const refusals = []
    for (const tab of [claude, codex]) {
      refusals.push(await ui(`window.copilotDesktop.createTask(${JSON.stringify(tab.id)}, 'Track me', false).then(() => 'created', error => String(error.message ?? error))`))
    }
    assert.match(refusals[0], /Tasks track Copilot sessions; this one runs Claude Code/)
    assert.match(refusals[1], /Tasks track Copilot sessions; this one runs Codex CLI/)
    assert.deepEqual((await ui('window.copilotDesktop.getState()')).workflowTasks ?? [], [], 'no task record was made for another CLI\'s conversation')
    const offeredSessions = await ui(`[...document.querySelectorAll('select')].filter(select => select.closest('form')?.innerText.includes('Track')).flatMap(select => [...select.options].map(option => option.innerText))`)
    assert.ok(!offeredSessions.some(name => /Claude|Codex/.test(name)), `the Tasks session list leaves other CLIs out: ${JSON.stringify(offeredSessions)}`)
    results.tasksRefused = refusals

    // Restart, Claude Code session never stored: it starts fresh under the same id rather than resuming nothing.
    const firstPid = claude.processId
    await ui(`window.copilotDesktop.restartTab(${JSON.stringify(claude.id)})`)
    claude = await tabWhere(tab => tab.id === claude.id && tab.status === 'running' && tab.processId && tab.processId !== firstPid, 'Claude Code restarted')
    line = commandLine(claude.processId)
    assert.ok(line?.includes(`--session-id ${claude.lastSessionId}`), `an unstored session starts fresh under its id: ${line}`)
    results.claudeRestartedFresh = line

    // Restart, session stored (staged: the file Claude Code writes with the first prompt): it resumes by id.
    await mkdir(join(process.env.CLAUDE_CONFIG_DIR, 'projects', 'check-project'), { recursive: true })
    await writeFile(join(process.env.CLAUDE_CONFIG_DIR, 'projects', 'check-project', `${claude.lastSessionId}.jsonl`), '')
    const secondPid = claude.processId
    const restartedClaude = ui(`window.copilotDesktop.restartTab(${JSON.stringify(claude.id)}).then(() => true, () => false)`)
    let resumed = null
    for (let attempt = 0; attempt < 100 && !resumed; attempt++) {
      const current = (await tabs()).find(tab => tab.id === claude.id)
      if (current?.processId && current.processId !== secondPid) resumed = commandLine(current.processId)
      if (!resumed) await delay(100)
    }
    await restartedClaude
    assert.ok(resumed?.includes(`--resume ${claude.lastSessionId}`), `a stored session is resumed by id: ${resumed}`)
    results.claudeResumed = resumed

    // Restart, Codex: it resumes the session whose id the tab took.
    const codexPid = codex.processId
    const restartedCodex = ui(`window.copilotDesktop.restartTab(${JSON.stringify(codex.id)}).then(() => true, () => false)`)
    resumed = null
    for (let attempt = 0; attempt < 100 && !resumed; attempt++) {
      const current = (await tabs()).find(tab => tab.id === codex.id)
      if (current?.processId && current.processId !== codexPid) resumed = commandLine(current.processId)
      if (!resumed) await delay(100)
    }
    await restartedCodex
    assert.ok(resumed && new RegExp(`\\bresume ${codexId}`).test(resumed), `Codex resumes its session by id: ${resumed}`)
    results.codexResumed = resumed

    const agyPid = antigravity.processId
    await ui(`window.copilotDesktop.unloadTab(${JSON.stringify(antigravity.id)})`)
    await tabWhere(tab => tab.id === antigravity.id && tab.status === 'dormant', 'Antigravity is unloaded')
    await ui(`window.copilotDesktop.restartTab(${JSON.stringify(antigravity.id)})`)
    antigravity = await tabWhere(tab => tab.id === antigravity.id && tab.status === 'running' && tab.processId && tab.processId !== agyPid, 'Antigravity is restarted')
    line = commandLine(antigravity.processId)
    assert.match(line ?? '', /[\\/]agy(?:\.exe)?"?\s*$/i, 'Antigravity starts without selecting a conversation before one is stored')
    assert.equal(JSON.parse(await readFile(mcpConfig, 'utf8')).mcpServers['copilot-meeting'].serverUrl, installedMcp)
    results.antigravityRestarted = line

    // Antigravity stores a conversation (staged: its summary + db appear for the project folder) and the tab takes its id.
    const agyId = '0199bbbb-cccc-4ddd-8eee-ffffffffffff'
    const agyRoot = join(process.env.ANTIGRAVITY_GEMINI_DIR, 'antigravity-cli')
    await mkdir(join(agyRoot, 'conversations'), { recursive: true })
    await writeFile(join(agyRoot, 'conversations', `${agyId}.db`), '')
    const summaryDb = new DatabaseSync(join(agyRoot, 'conversation_summaries.db'))
    try {
      summaryDb.exec(`CREATE TABLE IF NOT EXISTS conversation_summaries (
        conversation_id TEXT PRIMARY KEY,
        workspace_uris TEXT NOT NULL,
        parent_conversation_id TEXT NOT NULL DEFAULT '',
        nesting_depth INTEGER NOT NULL DEFAULT 0
      )`)
      summaryDb.prepare('INSERT OR REPLACE INTO conversation_summaries (conversation_id, workspace_uris, parent_conversation_id, nesting_depth) VALUES (?, ?, ?, ?)')
        .run(agyId, JSON.stringify([pathToFileURL(repo).href]), '', 0)
    } finally { summaryDb.close() }
    antigravity = await tabWhere(tab => tab.cli === 'antigravity' && tab.lastSessionId === agyId, 'the Antigravity tab takes the id of the conversation agy stored')
    await untilSaved(list => list.some(tab => tab.cli === 'antigravity' && tab.lastSessionId === agyId), 'the Antigravity conversation id is saved')
    results.antigravitySessionFound = agyId

    // Restart, stored Antigravity conversation: it launches with --conversation <id>.
    const agySecondPid = antigravity.processId
    const restartedAgy = ui(`window.copilotDesktop.restartTab(${JSON.stringify(antigravity.id)}).then(() => true, () => false)`)
    resumed = null
    for (let attempt = 0; attempt < 50 && !resumed; attempt++) {
      const current = (await tabs()).find(tab => tab.id === antigravity.id)
      if (current?.processId && current.processId !== agySecondPid) resumed = commandLine(current.processId)
      if (!resumed && current?.status === 'crashed') break
      if (!resumed) await delay(50)
    }
    await restartedAgy
    if (resumed) {
      assert.ok(resumed.includes(`--conversation ${agyId}`), `Antigravity resumes its conversation by id: ${resumed}`)
    } else {
      // The node.exe fixture exits immediately on unknown --conversation; verify it rejected that exact flag.
      const crashed = await tabWhere(tab => tab.id === antigravity.id && tab.status === 'crashed' && tab.lastSessionId === agyId, 'node fixture exits on --conversation')
      assert.equal(crashed.lastSessionId, agyId)
      const terminalOutput = await ui(`window.copilotDesktop.getTabBacklog(${JSON.stringify(antigravity.id)})`).catch(() => '')
      assert.match(String(terminalOutput), /--conversation/, 'Antigravity restart passed --conversation to the CLI')
    }
    results.antigravityResumed = resumed ?? `--conversation ${agyId}`

    // The Copilot tab is untouched by all this: still the only one with a permission preset.
    const all = await tabs()
    assert.deepEqual(all.map(tab => [tab.cli ?? 'copilot', tab.sessionPermissionPreset !== null]), [['copilot', true], ['claude', false], ['codex', false], ['antigravity', false]])

    // All 4 CLI homes received the 3 packaged PR workflow skills (review-pr, fix-pr, review-and-fix-pr).
    const skillDirs = [
      join(process.env.COPILOT_HOME, 'skills'),
      join(process.env.CLAUDE_CONFIG_DIR, 'skills'),
      join(process.env.CODEX_HOME, 'skills'),
      join(process.env.ANTIGRAVITY_GEMINI_DIR, 'config', 'skills'),
    ]
    for (const rootSkills of skillDirs) {
      for (const skillName of ['review-pr', 'fix-pr', 'review-and-fix-pr']) {
        const text = await readFile(join(rootSkills, skillName, 'SKILL.md'), 'utf8')
        assert.match(text, new RegExp(`^name: ${skillName}$`, 'm'), `${rootSkills} has ${skillName}/SKILL.md`)
      }
    }

    for (const tab of all) await ui(`window.copilotDesktop.closeTab(${JSON.stringify(tab.id)})`).catch(() => {})
    await writeFile(join(out, 'result.json'), JSON.stringify({ passed: true, ...results }, null, 2))
    app.quit()
  }
}

// End-to-end verification of multi-CLI PR workflow skill provisioning, environment wiring, one-shot reviewer execution,
// remote Gitea forge evidence verification (incomplete -> retry findings -> pre-push barrier -> round 2 worktree reuse -> approved),
// and clean worktree teardown inside the real Electron app.
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createServer, request } from 'node:http'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const artifacts = resolve('test-results/pr-workflows-e2e')
const delay = (ms) => new Promise((accept) => setTimeout(accept, ms))

function mcpPost(urlStr, body, sessionId) {
  const parsed = new URL(urlStr)
  return new Promise((resolveReq, rejectReq) => {
    const payload = JSON.stringify(body)
    const req = request(
      {
        host: parsed.hostname,
        port: Number(parsed.port),
        path: `${parsed.pathname}${parsed.search}`,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
          ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
        },
      },
      (res) => {
        const chunks = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          resolveReq({
            status: res.statusCode ?? 0,
            sessionId: res.headers['mcp-session-id'] ?? null,
            json: text ? JSON.parse(text) : null,
          })
        })
      },
    )
    req.on('error', rejectReq)
    req.end(payload)
  })
}

if (!process.versions.electron) {
  await mkdir(artifacts, { recursive: true })
  await writeFile(join(artifacts, 'result.json'), JSON.stringify({ passed: false }))
  const base = process.env.CHECK_TMP ?? tmpdir()
  await mkdir(base, { recursive: true })
  const directory = await mkdtemp(join(base, 'pr-workflows-e2e-'))
  let timer
  try {
    const bin = join(directory, 'bin')
    await mkdir(bin, { recursive: true })
    const stubScript = join(directory, 'agy-stub.mjs')
    await writeFile(
      stubScript,
      [
        "import { execFileSync } from 'node:child_process'",
        "import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'",
        "import { join } from 'node:path'",
        'const args = process.argv.slice(2)',
        "if (args.includes('--version')) { console.log('agy 2.0.99-e2e'); process.exit(0) }",
        "if (args.includes('--help')) {",
        "  console.log('Usage: agy [options]\\n  --dangerously-skip-permissions\\n  --add-dir <dir>\\n  --prompt-interactive <prompt>\\n  --print <prompt>\\n  --conversation <id>\\n  --mode <mode>\\n  --model <model>')",
        '  process.exit(0)',
        '}',
        'const dumpDir = process.env.E2E_STUB_DUMP_DIR',
        'const dumpPid = process.env.E2E_WRAPPER_PID || String(process.pid)',
        'const isOneShot = args.includes("--print")',
        'let behavior = { mode: "silent" }',
        'if (process.env.E2E_STUB_BEHAVIOR_FILE) {',
        '  try { behavior = JSON.parse(readFileSync(process.env.E2E_STUB_BEHAVIOR_FILE, "utf8")) } catch {}',
        '}',
        'if (dumpDir) {',
        '  mkdirSync(dumpDir, { recursive: true })',
        '  writeFileSync(join(dumpDir, `agy-${dumpPid}.json`), JSON.stringify({',
        '    pid: Number(dumpPid),',
        '    cwd: process.cwd(),',
        '    args,',
        '    isOneShot,',
        '    mode: behavior.mode,',
        '    prTools: process.env.COPILOT_DESKTOP_PR_TOOLS ?? null,',
        '    prState: process.env.COPILOT_DESKTOP_PR_STATE ?? null,',
        '    seatReceipt: process.env.COPILOT_DESKTOP_SEAT_RECEIPT ?? null,',
        '    allowHttpOrigin: process.env.COPILOT_DESKTOP_ALLOW_HTTP_ORIGIN ?? null,',
        '  }, null, 2))',
        '}',
        'if (!isOneShot) {',
        '  setInterval(() => {}, 10_000)',
        '} else {',
        '  const runOneShot = async () => {',
        '    if (behavior.holdMs) await new Promise((r) => setTimeout(r, behavior.holdMs))',
        '    if (behavior.mode === "silent") {',
        '      return',
        '    }',
        '    if (behavior.mode === "findings" && behavior.giteaOrigin) {',
        '      const res = await fetch(`${behavior.giteaOrigin}/api/v1/repos/daq/daq-service/issues/12/comments`, {',
        '        method: "POST",',
        '        headers: { "content-type": "application/json", authorization: "token e2e-tok", connection: "close" },',
        '        body: JSON.stringify({ body: "Blocking: [Antigravity CLI] bump version to 3 before merging." }),',
        '      })',
        '      const posted = await res.json()',
        '      if (process.env.COPILOT_DESKTOP_PR_TOOLS && process.env.COPILOT_DESKTOP_SEAT_RECEIPT) {',
        '        execFileSync(process.execPath, [join(process.env.COPILOT_DESKTOP_PR_TOOLS, "pr-seat-receipt.mjs"), "--kind", "findings", "--id", String(posted.id)], { stdio: "inherit" })',
        '      }',
        '      return',
        '    }',
        '    if (behavior.mode === "approve" && behavior.giteaOrigin && process.env.COPILOT_DESKTOP_PR_TOOLS && process.env.COPILOT_DESKTOP_SEAT_RECEIPT) {',
        '      const cfg = JSON.parse(readFileSync(process.env.COPILOT_DESKTOP_SEAT_RECEIPT, "utf8"))',
        '      const notePath = join(dumpDir, `approve-note-${dumpPid}.md`)',
        '      writeFileSync(notePath, "[Antigravity CLI] Verified round 2 fix and checks pass.\\n")',
        '      const out = execFileSync(process.execPath, [',
        '        join(process.env.COPILOT_DESKTOP_PR_TOOLS, "pr-approve.mjs"),',
        '        `${behavior.giteaOrigin}/daq/daq-service/pulls/12`,',
        '        "12",',
        '        cfg.head,',
        '        cfg.base,',
        '        notePath,',
        '      ], { encoding: "utf8", env: { ...process.env, GITEA_TOKEN: "e2e-tok", GITEA_URL: behavior.giteaOrigin } })',
        '      const parsedApprove = JSON.parse(out)',
        '      execFileSync(process.execPath, [join(process.env.COPILOT_DESKTOP_PR_TOOLS, "pr-seat-receipt.mjs"), "--kind", "approved", "--id", String(parsedApprove.id)], { stdio: "inherit" })',
        '      return',
        '    }',
        '  }',
        '  runOneShot().catch((err) => { console.error(err); process.exitCode = 1 })',
        '}',
      ].join('\n'),
      'utf8',
    )
    if (process.platform === 'win32') {
      const cscCandidates = [
        join(process.env.SystemRoot ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
        join(process.env.SystemRoot ?? 'C:\\Windows', 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe'),
      ]
      let csc = null
      for (const candidate of cscCandidates) {
        if (await stat(candidate).then(() => true, () => false)) {
          csc = candidate
          break
        }
      }
      if (csc) {
        const csFile = join(directory, 'AgyStub.cs')
        const agyExe = join(bin, 'agy.exe')
        await writeFile(
          csFile,
          `using System;
using System.Diagnostics;
using System.Text;
class AgyStub {
  static int Main(string[] args) {
    var psi = new ProcessStartInfo(${JSON.stringify(process.execPath)});
    var sb = new StringBuilder();
    sb.Append("\\"").Append(${JSON.stringify(stubScript)}.Replace("\\\\", "\\\\\\\\").Replace("\\"", "\\\\\\"")).Append("\\"");
    foreach (var a in args) {
      sb.Append(" \\"").Append(a.Replace("\\\\", "\\\\\\\\").Replace("\\"", "\\\\\\"")).Append("\\"");
    }
    psi.Arguments = sb.ToString();
    psi.UseShellExecute = false;
    psi.EnvironmentVariables["E2E_WRAPPER_PID"] = Process.GetCurrentProcess().Id.ToString();
    var p = Process.Start(psi);
    p.WaitForExit();
    return p.ExitCode;
  }
}
`,
          'utf8',
        )
        execFileSync(csc, ['/nologo', `/out:${agyExe}`, csFile], { stdio: 'pipe', windowsHide: true })
      } else {
        await copyFile(process.execPath, join(bin, 'agy.exe'))
      }
    } else {
      const agySh = join(bin, 'agy')
      await writeFile(agySh, `#!/bin/sh\nexec "${process.execPath}" "${stubScript}" "$@"\n`, { mode: 0o755 })
    }

    const pathKey = Object.keys(process.env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH'
    const env = {
      ...process.env,
      E2E_DIR: directory,
      E2E_ARTIFACTS: artifacts,
      E2E_STUB_DUMP_DIR: join(directory, 'stub-dumps'),
      E2E_STUB_BEHAVIOR_FILE: join(directory, 'stub-behavior.json'),
      COPILOT_DESKTOP_MEETING_MCP_PORT: '0',
      ANTIGRAVITY_GEMINI_DIR: join(directory, 'gemini-home'),
      GITEA_TOKEN: 'e2e-tok',
      [pathKey]: [bin, process.env[pathKey]].filter(Boolean).join(delimiter),
    }
    delete env.ELECTRON_RUN_AS_NODE
    delete env.SHELL
    const child = spawn((await import('electron')).default, [fileURLToPath(import.meta.url)], {
      env,
      stdio: 'inherit',
      windowsHide: true,
    })
    timer = setTimeout(() => child.kill(), 240_000)
    const code = await new Promise((accept, reject) => {
      child.once('error', reject)
      child.once('exit', accept)
    })
    assert.equal(code, 0, 'PR workflows Electron E2E check failed')
    const result = JSON.parse(await readFile(join(artifacts, 'result.json'), 'utf8'))
    assert.equal(result.passed, true)
    console.log('PR workflow skills, one-shot reviewer lifecycle, remote Gitea verification, worktree reuse, and clean teardown verified end-to-end.')
  } finally {
    clearTimeout(timer)
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }).catch(() => {})
  }
} else {
  const { app, BrowserWindow, dialog } = await import('electron')
  const directory = process.env.E2E_DIR
  const out = process.env.E2E_ARTIFACTS
  const dumpDir = process.env.E2E_STUB_DUMP_DIR
  const behaviorFile = process.env.E2E_STUB_BEHAVIOR_FILE
  const userData = join(directory, 'userdata')
  app.setPath('userData', userData)

  // Auto-accept the temporary PR reviewer consent dialog in headless E2E verification.
  dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false })

  let giteaServer = null
  void run().catch(async (error) => {
    console.error(error)
    await writeFile(join(out, 'result.json'), JSON.stringify({ passed: false, error: String(error?.stack ?? error) })).catch(() => {})
    app.exit(1)
  })

  async function run() {
    for (const name of ['copilot-home', 'claude-home', 'codex-home', 'gemini-home', 'userdata', 'stub-dumps']) {
      await mkdir(join(directory, name), { recursive: true })
    }
    // Seed legacy unmanaged review-pr skills to verify Electron startup upgrades and backs them up automatically!
    await mkdir(join(directory, 'claude-home', 'skills', 'review-pr'), { recursive: true })
    await writeFile(join(directory, 'claude-home', 'skills', 'review-pr', 'SKILL.md'), '# Legacy Claude review-pr\n')
    await mkdir(join(directory, 'codex-home', 'skills', 'review-pr', 'scripts'), { recursive: true })
    await writeFile(join(directory, 'codex-home', 'skills', 'review-pr', 'SKILL.md'), '# Legacy Codex review-pr\n')
    await writeFile(join(directory, 'codex-home', 'skills', 'review-pr', 'scripts', 'pr_supervisor.py'), 'legacy = True\n')

    await writeFile(
      join(directory, 'gitconfig'),
      '[user]\n\tname = E2E Check\n\temail = e2e@example.com\n[init]\n\tdefaultBranch = main\n',
    )
    process.env.GIT_CONFIG_NOSYSTEM = '1'
    process.env.GIT_CONFIG_GLOBAL = join(directory, 'gitconfig')
    process.env.COPILOT_HOME = join(directory, 'copilot-home')
    process.env.COPILOT_DISABLE_KEYTAR = '1'
    process.env.CLAUDE_CONFIG_DIR = join(directory, 'claude-home')
    process.env.CODEX_HOME = join(directory, 'codex-home')
    await writeFile(join(directory, 'copilot-home', 'config.json'), JSON.stringify({ trustedFolders: [directory] }))

    // Start real local mock Gitea HTTP API server for PR #12!
    let giteaHead = ''
    let giteaBase = ''
    let nextIssueCommentId = 900
    const giteaReviews = []
    const giteaIssueComments = []
    giteaServer = createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const chunks = []
      for await (const c of req) chunks.push(c)
      const bodyText = Buffer.concat(chunks).toString('utf8')

      if (url.pathname === '/api/v1/version') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ version: '1.22.0' }))
        return
      }
      if (url.pathname === '/api/v1/user') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ id: 7, login: 'e2e-user' }))
        return
      }
      if (url.pathname === '/api/v1/repos/daq/daq-service/pulls/12') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({
          number: 12,
          state: 'open',
          merged: false,
          user: { id: 7, login: 'e2e-user' },
          head: { ref: 'feat/gitea-pr-12', sha: giteaHead, repo: { id: 42, full_name: 'daq/daq-service' } },
          base: { ref: 'main', sha: giteaBase, repo: { id: 42, full_name: 'daq/daq-service' } },
        }))
        return
      }
      if (url.pathname === '/api/v1/repos/daq/daq-service/pulls/12/files') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify([{ filename: 'service.ts' }]))
        return
      }
      if (url.pathname === '/api/v1/repos/daq/daq-service/pulls/12/reviews') {
        if (req.method === 'POST') {
          const parsed = JSON.parse(bodyText)
          const nowIso = new Date().toISOString()
          const item = {
            id: ++nextIssueCommentId,
            state: parsed.event === 'APPROVE' ? 'APPROVED' : 'COMMENT',
            user: { id: 7, login: 'e2e-user' },
            body: parsed.body,
            commit_id: parsed.commit_id,
            submitted_at: nowIso,
            updated_at: nowIso,
            html_url: `http://127.0.0.1/daq/daq-service/pulls/12#pullrequestreview-${nextIssueCommentId}`,
          }
          giteaReviews.push(item)
          res.writeHead(201, { 'content-type': 'application/json' })
          res.end(JSON.stringify(item))
          return
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(giteaReviews))
        return
      }
      const reviewById = /^\/api\/v1\/repos\/daq\/daq-service\/pulls\/12\/reviews\/(\d+)$/.exec(url.pathname)
      if (reviewById) {
        const found = giteaReviews.find((r) => Number(r.id) === Number(reviewById[1]))
        res.writeHead(found ? 200 : 404, { 'content-type': 'application/json' })
        res.end(JSON.stringify(found ?? { message: 'Not found' }))
        return
      }
      const reviewComments = /^\/api\/v1\/repos\/daq\/daq-service\/pulls\/12\/reviews\/(\d+)\/comments$/.exec(url.pathname)
      if (reviewComments) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify([]))
        return
      }
      if (url.pathname === '/api/v1/repos/daq/daq-service/issues/12/comments') {
        if (req.method === 'POST') {
          const parsed = JSON.parse(bodyText)
          const nowIso = new Date().toISOString()
          const item = {
            id: ++nextIssueCommentId,
            user: { id: 7, login: 'e2e-user' },
            body: parsed.body,
            created_at: nowIso,
            updated_at: nowIso,
            html_url: `http://127.0.0.1/daq/daq-service/pulls/12#issuecomment-${nextIssueCommentId}`,
          }
          giteaIssueComments.push(item)
          res.writeHead(201, { 'content-type': 'application/json' })
          res.end(JSON.stringify(item))
          return
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(giteaIssueComments))
        return
      }
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ message: `Not found: ${url.pathname}` }))
    })
    const giteaPort = await new Promise((resolvePort, reject) => {
      giteaServer.once('error', reject)
      giteaServer.listen(0, '127.0.0.1', () => resolvePort(giteaServer.address().port))
    })
    const giteaOrigin = `http://127.0.0.1:${giteaPort}`
    process.env.GITEA_URL = giteaOrigin
    const prUrl = `${giteaOrigin}/daq/daq-service/pulls/12`

    // Create bare remote origin + working repository with main (base) and feat/gitea-pr-12 (head1).
    const originBare = join(directory, 'origin.git')
    const repo = join(directory, 'project')
    await mkdir(originBare, { recursive: true })
    await mkdir(repo, { recursive: true })
    execFileSync('git', ['init', '--bare', '-q'], { cwd: originBare, env: process.env })
    const git = (...args) =>
      execFileSync('git', args, { cwd: repo, env: process.env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
    git('init', '-q')
    git('remote', 'add', 'origin', `${giteaOrigin}/daq/daq-service.git`)
    git('remote', 'set-url', '--push', 'origin', originBare)
    await writeFile(join(repo, 'service.ts'), 'export const version = 1\n')
    git('add', '.')
    git('commit', '-q', '-m', 'initial main')
    const mergeBaseSha = git('rev-parse', 'HEAD')
    git('push', '-q', originBare, 'main:refs/heads/main')

    git('checkout', '-q', '-b', 'feat/gitea-pr-12')
    await writeFile(join(repo, 'service.ts'), 'export const version = 2\n')
    git('add', '.')
    git('commit', '-q', '-m', 'feat round 1')
    const head1Sha = git('rev-parse', 'HEAD')
    git('push', '-q', originBare, 'feat/gitea-pr-12:refs/heads/feat/gitea-pr-12')
    git('update-ref', 'refs/remotes/origin/feat/gitea-pr-12', head1Sha)

    // Advance target branch `main` AFTER branching `feat/gitea-pr-12` so `origin/main` tip !== `merge-base(origin/main, head1Sha)`!
    // This verifies divergent branches work end-to-end across resolveGitRevisionsForReview, pr-approve.mjs, and pr_reviewers_finish("approved").
    git('checkout', '-q', 'main')
    await writeFile(join(repo, 'unrelated-main.ts'), 'export const mainExtra = true\n')
    git('add', '.')
    git('commit', '-q', '-m', 'advance main past merge-base')
    const baseSha = git('rev-parse', 'HEAD')
    assert.notEqual(baseSha, mergeBaseSha, 'target branch tip advanced past merge-base')
    git('push', '-q', originBare, 'main:refs/heads/main')
    git('update-ref', 'refs/remotes/origin/main', baseSha)
    git('checkout', '-q', 'feat/gitea-pr-12')

    giteaBase = baseSha
    giteaHead = head1Sha

    const { createWorkspaceProfile, DEFAULT_DESKTOP_CONFIG, writeDesktopConfig } = await import('../dist/src/main/desktop-config.js')
    const project = createWorkspaceProfile(repo)
    project.defaultResumeMode = 'new'
    project.reviewerClis = ['antigravity']
    await writeDesktopConfig(join(userData, 'desktop.json'), {
      ...DEFAULT_DESKTOP_CONFIG,
      profiles: [project],
      activeProfileId: project.id,
      reviewerClis: ['antigravity'],
      reviewerAllowAll: true,
      reviewerStartPrompt: true,
      closeBehavior: 'quit',
      trayEnabled: false,
      notifications: false,
      automaticUpdateChecks: false,
    })

    await import('../dist/src/main/main.js')
    await app.whenReady()

    let main
    for (let attempt = 0; attempt < 150 && !main; attempt++) {
      main = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().endsWith('index.html'))
      if (!main) await delay(100)
    }
    assert.ok(main, 'main window loaded')
    const ui = (code) => main.webContents.executeJavaScript(code)
    for (let i = 0; i < 150; i++) {
      const ready = await ui('typeof window.copilotDesktop?.getState === "function"').catch(() => false)
      if (ready) break
      await delay(100)
    }
    const getState = () => ui('window.copilotDesktop.getState()')

    let state = await getState()
    for (let i = 0; i < 100 && !state?.meetingToolsUrl; i++) {
      await delay(100)
      state = await getState()
    }
    assert.match(state.meetingToolsUrl ?? '', /^http:\/\/127\.0\.0\.1:\d+\/mcp$/)

    // 1. Verify startup provisioned all 3 forge-agnostic skills across all 4 CLI homes AND backed up legacy skills!
    for (const [cliName, skillsRoot] of [
      ['copilot', join(process.env.COPILOT_HOME, 'skills')],
      ['claude', join(process.env.CLAUDE_CONFIG_DIR, 'skills')],
      ['codex', join(process.env.CODEX_HOME, 'skills')],
      ['antigravity', join(process.env.ANTIGRAVITY_GEMINI_DIR, 'config', 'skills')],
    ]) {
      for (const skillName of ['review-pr', 'fix-pr', 'review-and-fix-pr', 'review-meeting']) {
        const skillMd = await readFile(join(skillsRoot, skillName, 'SKILL.md'), 'utf8')
        assert.match(skillMd, new RegExp(`^name: ${skillName}$`, 'm'), `${cliName} has ${skillName}`)
        assert.doesNotMatch(skillMd, /Legacy /, `${cliName} ${skillName} upgraded from legacy`)
      }
    }
    assert.equal(
      await readFile(join(process.env.CLAUDE_CONFIG_DIR, '.copilot-desktop-skill-backups', 'review-pr', 'SKILL.md'), 'utf8'),
      '# Legacy Claude review-pr\n',
    )
    assert.equal(
      await readFile(join(process.env.CODEX_HOME, '.copilot-desktop-skill-backups', 'review-pr', 'scripts', 'pr_supervisor.py'), 'utf8'),
      'legacy = True\n',
    )
    await assert.rejects(stat(join(process.env.CODEX_HOME, 'skills', 'review-pr', 'scripts')), { code: 'ENOENT' })

    // 2. Launch a foreground Antigravity tab AND restart it, verifying interactive mode + env vars!
    await ui(`window.copilotDesktop.createTab(null, undefined, 'Agy Foreground', { cli: 'antigravity' })`)
    let fgTab = null
    for (let i = 0; i < 100; i++) {
      const s = await getState()
      fgTab = s.tabs.find((t) => t.cli === 'antigravity' && !t.tempReviewer && t.status === 'running' && t.processId)
      if (fgTab) break
      await delay(100)
    }
    assert.ok(fgTab, 'foreground Antigravity tab started')

    const waitDumpForPid = async (pid) => {
      const target = join(dumpDir, `agy-${pid}.json`)
      for (let i = 0; i < 80; i++) {
        const txt = await readFile(target, 'utf8').catch(() => null)
        if (txt) return JSON.parse(txt)
        await delay(100)
      }
      return null
    }

    const firstDump = await waitDumpForPid(fgTab.processId)
    assert.ok(firstDump, 'captured foreground Antigravity stub dump')
    assert.equal(firstDump.isOneShot, false, 'foreground tab runs interactively')
    assert.ok(firstDump.prTools && firstDump.prTools.endsWith('pr-workflows'))
    assert.ok(firstDump.prState && firstDump.prState.endsWith('pr-workflow-state'))

    const oldFgPid = fgTab.processId
    await ui(`window.copilotDesktop.restartTab(${JSON.stringify(fgTab.id)})`)
    let restartedFgTab = null
    for (let i = 0; i < 100; i++) {
      const s = await getState()
      const candidate = s.tabs.find((t) => t.id === fgTab.id && t.status === 'running' && t.processId && t.processId !== oldFgPid)
      if (candidate) {
        restartedFgTab = candidate
        break
      }
      await delay(100)
    }
    assert.ok(restartedFgTab, 'foreground Antigravity tab restarted')
    const restartDump = await waitDumpForPid(restartedFgTab.processId)
    assert.ok(restartDump, 'captured restarted Antigravity stub dump')
    assert.ok(restartDump.prTools && restartDump.prTools.endsWith('pr-workflows'))

    // 3. Exercise full hardened MCP pr_reviewers_* lifecycle on Gitea PR #12!
    const mcpUrl = state.meetingToolsUrl
    const initRes = await mcpPost(mcpUrl, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-code', version: '2.1.0' } },
    })
    const mcpSessionId = initRes.sessionId
    assert.ok(mcpSessionId)

    // 3a. Mode "silent": one-shot reviewer exits 0 WITHOUT posting to Gitea -> must settle as 'incomplete' and refuse finish('approved')!
    await writeFile(behaviorFile, JSON.stringify({ mode: 'silent', giteaOrigin }))
    const startRes = await mcpPost(
      mcpUrl,
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'pr_reviewers_start',
          arguments: {
            folder: repo,
            pr: 12,
            pr_url: prUrl,
            head: head1Sha,
            base: 'origin/main',
          },
        },
      },
      mcpSessionId,
    )
    assert.equal(startRes.json.result.isError, undefined, startRes.json.result.content?.[0]?.text)
    const startPayload = JSON.parse(startRes.json.result.content[0].text)
    const groupId = startPayload.group.id
    assert.equal(startPayload.group.prNumber, 12)
    assert.equal(startPayload.group.base, baseSha, 'divergent origin/main resolves to target branch tip SHA, not merge-base')
    assert.deepEqual(startPayload.expectedReviewerTags, ['[Antigravity CLI]'])

    let incompletePayload = null
    for (let i = 0; i < 80; i++) {
      const waitRes = await mcpPost(
        mcpUrl,
        { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'pr_reviewers_wait', arguments: { wait_seconds: 2 } } },
        mcpSessionId,
      )
      const parsed = JSON.parse(waitRes.json.result.content[0].text)
      if (parsed.allSeatsSettledForRound && parsed.group.seats[0]?.verdict === 'incomplete') {
        incompletePayload = parsed
        break
      }
      await delay(100)
    }
    assert.ok(incompletePayload, 'silent exit 0 without PR post settled as incomplete')
    assert.equal(incompletePayload.allApprovedCurrentHead, false)
    assert.equal(incompletePayload.group.seats[0].needsAttention, true)

    // Refuses pr_reviewers_finish(outcome: 'approved') when seat is incomplete!
    const prematureFinish1 = await mcpPost(
      mcpUrl,
      { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'pr_reviewers_finish', arguments: { outcome: 'approved' } } },
      mcpSessionId,
    )
    assert.equal(prematureFinish1.json.result.isError, true, 'finish("approved") refused when seat is incomplete')

    // 3b. Mode "findings" + holdMs 1500: Retry seat from UI; while running, verify pr_reviewers_round refuses premature advance; then verify 'findings' settles!
    await writeFile(behaviorFile, JSON.stringify({ mode: 'findings', giteaOrigin, holdMs: 1200 }))
    await ui(`window.copilotDesktop.tempReviewerAction(${JSON.stringify(groupId)}, 'retry', 'antigravity')`)

    let retryRunningTab = null
    for (let i = 0; i < 60; i++) {
      const s = await getState()
      const seat = s.tempReviewerGroups?.[0]?.seats?.[0]
      if (seat?.verdict === 'reviewing' && seat.tabId) {
        retryRunningTab = s.tabs.find((t) => t.id === seat.tabId)
        if (retryRunningTab?.processId) break
      }
      await delay(50)
    }
    assert.ok(retryRunningTab, 'retried reviewer is running')
    const reviewerDump1 = await waitDumpForPid(retryRunningTab.processId)
    assert.ok(reviewerDump1, 'captured one-shot reviewer dump')
    assert.equal(reviewerDump1.isOneShot, true, 'reviewerAllowAll launched Antigravity with --print one-shot')
    assert.ok(reviewerDump1.args.includes('--dangerously-skip-permissions'))
    assert.ok(reviewerDump1.seatReceipt && reviewerDump1.seatReceipt.endsWith('seat-receipt.json'))
    assert.equal(reviewerDump1.allowHttpOrigin, giteaOrigin.toLowerCase())
    const worktreePath1 = reviewerDump1.cwd
    assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: worktreePath1, encoding: 'utf8' }).trim(), head1Sha)

    // Wait for Round 1 findings to settle on Gitea!
    let findingsPayload = null
    for (let i = 0; i < 80; i++) {
      const waitRes = await mcpPost(
        mcpUrl,
        { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'pr_reviewers_wait', arguments: { wait_seconds: 3 } } },
        mcpSessionId,
      )
      const parsed = JSON.parse(waitRes.json.result.content[0].text)
      if (parsed.allSeatsSettledForRound && parsed.group.seats[0]?.verdict === 'findings') {
        findingsPayload = parsed
        break
      }
      await delay(100)
    }
    assert.ok(findingsPayload, 'Gitea findings + seat receipt settled seat as findings')
    assert.equal(findingsPayload.allApprovedCurrentHead, false)
    assert.equal(giteaIssueComments.length, 1)

    // Refuses pr_reviewers_finish(outcome: 'approved') when seat posted findings!
    const prematureFinish2 = await mcpPost(
      mcpUrl,
      { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'pr_reviewers_finish', arguments: { outcome: 'approved' } } },
      mcpSessionId,
    )
    assert.equal(prematureFinish2.json.result.isError, true, 'finish("approved") refused when seat has open findings')

    // 3c. Author fixes finding, pushes head2Sha, and calls pr_reviewers_round -> verifies worktree reuse + pr-approve.mjs approval!
    await writeFile(behaviorFile, JSON.stringify({ mode: 'approve', giteaOrigin }))
    await writeFile(join(repo, 'service.ts'), 'export const version = 3\n')
    git('add', '.')
    git('commit', '-q', '-m', 'fix reviewer finding round 2')
    const head2Sha = git('rev-parse', 'HEAD')
    git('push', '-q', originBare, 'feat/gitea-pr-12:refs/heads/feat/gitea-pr-12')
    git('update-ref', 'refs/remotes/origin/feat/gitea-pr-12', head2Sha)
    giteaHead = head2Sha

    const roundRes = await mcpPost(
      mcpUrl,
      {
        jsonrpc: '2.0',
        id: 8,
        method: 'tools/call',
        params: {
          name: 'pr_reviewers_round',
          arguments: {
            head: head2Sha,
            base: 'origin/main',
            summary: `🤖 Bumped version to 3 in ${head2Sha}`,
          },
        },
      },
      mcpSessionId,
    )
    assert.equal(roundRes.json.result.isError, undefined, roundRes.json.result.content?.[0]?.text)

    // Wait for Round 2 approval to settle!
    let approvedPayload = null
    for (let i = 0; i < 80; i++) {
      const waitRes = await mcpPost(
        mcpUrl,
        { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'pr_reviewers_wait', arguments: { wait_seconds: 3 } } },
        mcpSessionId,
      )
      const parsed = JSON.parse(waitRes.json.result.content[0].text)
      if (parsed.group.round === 2 && parsed.allSeatsSettledForRound && parsed.allApprovedCurrentHead) {
        approvedPayload = parsed
        break
      }
      await delay(100)
    }
    assert.ok(approvedPayload, 'Round 2 Gitea approval via pr-approve.mjs settled allApprovedCurrentHead === true')
    assert.equal(approvedPayload.group.seats[0].verdict, 'approved')
    assert.equal(approvedPayload.group.seats[0].checkedOut, head2Sha)

    // Verify worktree was reused cleanly on Round 2 (same checkout path, updated to head2Sha)!
    assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: worktreePath1, encoding: 'utf8' }).trim(), head2Sha, 'reused Round 1 worktree cleanly at head2Sha')

    // 3d. Finish review group as 'approved' (passes live Gitea verification) and verify hidden tabs + detached worktree are cleaned up!
    const finishRes = await mcpPost(
      mcpUrl,
      {
        jsonrpc: '2.0',
        id: 10,
        method: 'tools/call',
        params: { name: 'pr_reviewers_finish', arguments: { outcome: 'approved' } },
      },
      mcpSessionId,
    )
    assert.equal(finishRes.json.result.isError, undefined, finishRes.json.result.content?.[0]?.text)
    const finishPayload = JSON.parse(finishRes.json.result.content[0].text)
    assert.equal(finishPayload.done, true)
    assert.equal(finishPayload.group.outcome, 'approved')

    const finalState = await getState()
    assert.equal(
      finalState.tabs.some((t) => t.tempReviewer),
      false,
      'all hidden temporary reviewer tabs closed after pr_reviewers_finish',
    )
    await assert.rejects(stat(worktreePath1), { code: 'ENOENT' }, `detached reviewer worktree ${worktreePath1} removed cleanly`)
    const worktreeList = git('worktree', 'list', '--porcelain')
    assert.equal(
      worktreeList.split(/\r?\n/).filter((line) => line.startsWith('worktree ')).length,
      1,
      'zero leftover git worktrees in project repository',
    )

    for (const tab of finalState.tabs) {
      await ui(`window.copilotDesktop.closeTab(${JSON.stringify(tab.id)})`).catch(() => {})
    }
    await new Promise((r) => giteaServer.close(() => r()))
    await writeFile(
      join(out, 'result.json'),
      JSON.stringify(
        {
          passed: true,
          mcpUrl,
          giteaOrigin,
          baseSha,
          head1Sha,
          head2Sha,
          giteaCommentCount: giteaIssueComments.length,
        },
        null,
        2,
      ),
    )
    app.quit()
  }
}

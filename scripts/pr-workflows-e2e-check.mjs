// End-to-end verification of multi-CLI PR workflow skill provisioning, environment wiring, MCP pr_reviewers_* lifecycle
// (on both self-hosted Gitea and GitHub PR URLs), and helper pr-reviewers lifecycle inside the real Electron app.
import assert from 'node:assert/strict'
import { execFile, execFileSync, spawn } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { request } from 'node:http'
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
        "import { mkdirSync, writeFileSync } from 'node:fs'",
        "import { join } from 'node:path'",
        'const args = process.argv.slice(2)',
        "if (args.includes('--version')) { console.log('agy 2.0.99-e2e'); process.exit(0) }",
        "if (args.includes('--help')) {",
        "  console.log('Usage: agy [options]\\n  --dangerously-skip-permissions\\n  --add-dir <dir>\\n  --prompt-interactive <prompt>\\n  --conversation <id>\\n  --mode <mode>\\n  --model <model>')",
        '  process.exit(0)',
        '}',
        'const dumpDir = process.env.E2E_STUB_DUMP_DIR',
        'const dumpPid = process.env.E2E_WRAPPER_PID || String(process.pid)',
        'if (dumpDir) {',
        '  mkdirSync(dumpDir, { recursive: true })',
        '  writeFileSync(join(dumpDir, `agy-${dumpPid}.json`), JSON.stringify({',
        '    pid: Number(dumpPid),',
        '    cwd: process.cwd(),',
        '    args,',
        '    prTools: process.env.COPILOT_DESKTOP_PR_TOOLS ?? null,',
        '    prState: process.env.COPILOT_DESKTOP_PR_STATE ?? null,',
        '  }, null, 2))',
        '}',
        'setInterval(() => {}, 10_000)',
      ].join('\n'),
      'utf8',
    )
    if (process.platform === 'win32') {
      // Create a tiny native wrapper or cmd? Wait: agent-cli.ts for antigravity on win32 checks `.exe`!
      // On Windows, copy node.exe to agy.exe AND set NODE_OPTIONS? No, package.json sets enableNodeOptionsEnvironmentVariable: false only on packaged builds,
      // OR even better: node.exe with no args starts REPL, while with `--prompt-interactive` node fails unless we use a compiled/shim or we check how agent-cli resolves agy!
    }
    // Let's build a real cross-platform agy stub! On POSIX a chmod +x script works directly; on Windows let's check csc.exe or node.exe!
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
      COPILOT_DESKTOP_MEETING_MCP_PORT: '0',
      ANTIGRAVITY_GEMINI_DIR: join(directory, 'gemini-home'),
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
    console.log('PR workflow skills, environment variables, MCP pr_reviewers_*, and detached reviewer worktrees verified end-to-end.')
  } finally {
    clearTimeout(timer)
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }).catch(() => {})
  }
} else {
  const { app, BrowserWindow, dialog } = await import('electron')
  const directory = process.env.E2E_DIR
  const out = process.env.E2E_ARTIFACTS
  const dumpDir = process.env.E2E_STUB_DUMP_DIR
  const userData = join(directory, 'userdata')
  app.setPath('userData', userData)

  // Auto-accept the temporary PR reviewer consent dialog in headless E2E verification.
  dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false })

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

    // Create bare remote origin + working repository with main (base) and feat/gitea-pr-12 (head1).
    const originBare = join(directory, 'origin.git')
    const repo = join(directory, 'project')
    await mkdir(originBare, { recursive: true })
    await mkdir(repo, { recursive: true })
    execFileSync('git', ['init', '--bare', '-q'], { cwd: originBare, env: process.env })
    const git = (...args) =>
      execFileSync('git', args, { cwd: repo, env: process.env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
    git('init', '-q')
    git('remote', 'add', 'origin', originBare)
    await writeFile(join(repo, 'service.ts'), 'export const version = 1\n')
    git('add', '.')
    git('commit', '-q', '-m', 'initial main')
    const baseSha = git('rev-parse', 'HEAD')
    git('push', '-q', '-u', 'origin', 'main')

    git('checkout', '-q', '-b', 'feat/gitea-pr-12')
    await writeFile(join(repo, 'service.ts'), 'export const version = 2\n')
    git('add', '.')
    git('commit', '-q', '-m', 'feat round 1')
    const head1Sha = git('rev-parse', 'HEAD')
    git('push', '-q', '-u', 'origin', 'feat/gitea-pr-12')

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

    // Wait for startup provisioning + MCP server URL.
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
      for (const skillName of ['review-pr', 'fix-pr', 'review-and-fix-pr']) {
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

    // 2. Launch a foreground Antigravity tab AND restart it, verifying COPILOT_DESKTOP_PR_TOOLS & COPILOT_DESKTOP_PR_STATE reach both!
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
      for (let i = 0; i < 60; i++) {
        const txt = await readFile(target, 'utf8').catch(() => null)
        if (txt) return JSON.parse(txt)
        await delay(100)
      }
      return null
    }

    const firstDump = await waitDumpForPid(fgTab.processId)
    assert.ok(firstDump, 'captured foreground Antigravity stub dump')
    assert.ok(firstDump.prTools && firstDump.prTools.endsWith('pr-workflows'), `foreground start gets COPILOT_DESKTOP_PR_TOOLS: ${firstDump.prTools}`)
    assert.ok(firstDump.prState && firstDump.prState.endsWith('pr-workflow-state'), `foreground start gets COPILOT_DESKTOP_PR_STATE: ${firstDump.prState}`)

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
    assert.ok(restartDump.prTools && restartDump.prTools.endsWith('pr-workflows'), 'restarted tab preserves COPILOT_DESKTOP_PR_TOOLS')
    assert.ok(restartDump.prState && restartDump.prState.endsWith('pr-workflow-state'), 'restarted tab preserves COPILOT_DESKTOP_PR_STATE')

    // 3. Exercise full MCP pr_reviewers_start -> pr_reviewers_wait -> pr_reviewers_round -> pr_reviewers_finish on Gitea PR #12!
    const mcpUrl = state.meetingToolsUrl
    const initRes = await mcpPost(mcpUrl, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-code', version: '2.1.0' } },
    })
    assert.equal(initRes.status, 200)
    const mcpSessionId = initRes.sessionId
    assert.ok(mcpSessionId, 'MCP initialize returned session id')

    const toolsRes = await mcpPost(mcpUrl, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, mcpSessionId)
    const toolNames = toolsRes.json.result.tools.map((t) => t.name)
    for (const requiredTool of ['pr_reviewers_start', 'pr_reviewers_wait', 'pr_reviewers_round', 'pr_reviewers_finish']) {
      assert.ok(toolNames.includes(requiredTool), `MCP exposes ${requiredTool}`)
    }

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
            pr_url: 'http://omaha:3001/daq/daq-service/pulls/12',
            head: head1Sha,
            base: baseSha,
          },
        },
      },
      mcpSessionId,
    )
    assert.equal(startRes.json.result.isError, undefined, startRes.json.result.content?.[0]?.text)
    const startPayload = JSON.parse(startRes.json.result.content[0].text)
    assert.equal(startPayload.group.prNumber, 12)
    assert.equal(startPayload.group.prUrl, 'http://omaha:3001/daq/daq-service/pulls/12')
    assert.equal(startPayload.group.repository, 'omaha:3001/daq/daq-service')
    assert.deepEqual(startPayload.expectedReviewerTags, ['[Antigravity CLI]'])
    assert.match(startPayload.hostKey, /^[a-f0-9]{64}$/)

    // Wait until the hidden reviewer tab is running at head1Sha!
    let reviewerTab = null
    for (let i = 0; i < 100; i++) {
      const s = await getState()
      const grp = s.tempReviewerGroups?.[0]
      const seat = grp?.seats?.find((item) => item.cli === 'antigravity')
      if (grp?.stage === 'active' && seat?.verdict === 'reviewing' && seat.tabId) {
        reviewerTab = s.tabs.find((t) => t.id === seat.tabId)
        if (reviewerTab?.processId) break
      }
      await delay(100)
    }
    assert.ok(reviewerTab, 'hidden reviewer tab launched and reached reviewing state')
    assert.equal(reviewerTab.tempReviewer.prUrl, 'http://omaha:3001/daq/daq-service/pulls/12')

    const reviewerDump1 = await waitDumpForPid(reviewerTab.processId)
    assert.ok(reviewerDump1, 'captured Round 1 reviewer stub dump')
    const worktreePath1 = reviewerDump1.cwd
    assert.notEqual(reviewerDump1.cwd.toLowerCase(), repo.toLowerCase(), 'reviewer runs in isolated detached worktree, not author checkout')
    assert.ok(reviewerDump1.args.includes('--dangerously-skip-permissions'), 'reviewerAllowAll passed --dangerously-skip-permissions')
    assert.ok(reviewerDump1.args.includes('--prompt-interactive'), 'passed --prompt-interactive')
    assert.ok(reviewerDump1.prTools && reviewerDump1.prTools.endsWith('pr-workflows'), 'hidden reviewer gets COPILOT_DESKTOP_PR_TOOLS')
    assert.ok(reviewerDump1.prState && reviewerDump1.prState.endsWith('pr-state'), 'hidden reviewer gets isolated COPILOT_DESKTOP_PR_STATE')
    const checkedOutSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: reviewerDump1.cwd, encoding: 'utf8' }).trim()
    assert.equal(checkedOutSha, head1Sha, 'detached worktree checked out exact PR head1Sha')

    const waitRes = await mcpPost(
      mcpUrl,
      { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'pr_reviewers_wait', arguments: { wait_seconds: 1 } } },
      mcpSessionId,
    )
    const waitPayload = JSON.parse(waitRes.json.result.content[0].text)
    assert.equal(waitPayload.done, false)
    assert.equal(waitPayload.group.seats[0].verdict, 'reviewing')

    // Push Round 2 commit (head2Sha) to origin and advance via pr_reviewers_round!
    await writeFile(join(repo, 'service.ts'), 'export const version = 3\n')
    git('add', '.')
    git('commit', '-q', '-m', 'fix reviewer finding round 2')
    const head2Sha = git('rev-parse', 'HEAD')
    git('push', '-q', 'origin', 'feat/gitea-pr-12')

    const oldReviewerPid = reviewerTab.processId
    const roundRes = await mcpPost(
      mcpUrl,
      {
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: {
          name: 'pr_reviewers_round',
          arguments: {
            head: head2Sha,
            base: baseSha,
            summary: `🤖 Fixed reviewer finding in ${head2Sha}`,
          },
        },
      },
      mcpSessionId,
    )
    assert.equal(roundRes.json.result.isError, undefined, roundRes.json.result.content?.[0]?.text)

    // Wait for Round 2 relaunch on head2Sha!
    let reviewerTabRound2 = null
    for (let i = 0; i < 100; i++) {
      const s = await getState()
      const grp = s.tempReviewerGroups?.[0]
      const seat = grp?.seats?.find((item) => item.cli === 'antigravity')
      if (grp?.round === 2 && grp?.stage === 'active' && seat?.verdict === 'reviewing' && seat.tabId) {
        const candidate = s.tabs.find((t) => t.id === seat.tabId)
        if (candidate?.processId && candidate.processId !== oldReviewerPid) {
          reviewerTabRound2 = candidate
          break
        }
      }
      await delay(100)
    }
    assert.ok(reviewerTabRound2, 'reviewer relaunched on Round 2')
    const reviewerDump2 = await waitDumpForPid(reviewerTabRound2.processId)
    assert.ok(reviewerDump2, 'captured Round 2 reviewer stub dump')
    const worktreePath2 = reviewerDump2.cwd
    const checkedOutSha2 = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: reviewerDump2.cwd, encoding: 'utf8' }).trim()
    assert.equal(checkedOutSha2, head2Sha, 'Round 2 detached worktree checked out exact head2Sha')

    // Finish review group and verify hidden reviewer tabs AND detached worktrees are cleaned up!
    const finishRes = await mcpPost(
      mcpUrl,
      {
        jsonrpc: '2.0',
        id: 6,
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
    for (const wt of [worktreePath1, worktreePath2].filter(Boolean)) {
      await assert.rejects(stat(wt), { code: 'ENOENT' }, `detached reviewer worktree ${wt} removed cleanly`)
    }
    const worktreeList = git('worktree', 'list', '--porcelain')
    assert.equal(
      worktreeList.split(/\r?\n/).filter((line) => line.startsWith('worktree ')).length,
      1,
      'zero leftover git worktrees in project repository',
    )

    for (const tab of finalState.tabs) {
      await ui(`window.copilotDesktop.closeTab(${JSON.stringify(tab.id)})`).catch(() => {})
    }
    await writeFile(
      join(out, 'result.json'),
      JSON.stringify(
        {
          passed: true,
          mcpUrl,
          baseSha,
          head1Sha,
          head2Sha,
          verifiedStubDumps: Boolean(firstDump && restartDump && reviewerDump1 && reviewerDump2),
        },
        null,
        2,
      ),
    )
    app.quit()
  }
}

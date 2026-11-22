import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { githubCliConfigDirectories, reviewerDeniedPaths, reviewerEnvironment, reviewerLaunchArguments, reviewerSandboxPolicy, verifyReviewerHome, writeReviewerHome } from './pr-reviewer-sandbox.js'

const roots = (base: string) => ({ reviewerHome: join(base, 'reviewer'), userHome: join(base, 'user'), personCopilotHome: join(base, 'user', '.copilot'),
  desktopData: join(base, 'desktop'), appData: join(base, 'user', 'AppData', 'Roaming'), localAppData: join(base, 'user', 'AppData', 'Local') })

test('denied paths keep the reviewer home and only the other paths that exist', () => {
  const base = resolve(tmpdir(), 'reviewer-roots')
  const r = roots(base)
  const present = new Set([r.personCopilotHome, join(r.userHome, '.ssh'), join(r.localAppData, 'Google', 'Chrome'), join(r.appData, 'Mozilla'), r.desktopData])
  const denied = reviewerDeniedPaths(r, (path) => present.has(path))
  assert.ok(denied.includes(resolve(r.reviewerHome)), 'the reviewer home is denied even before it exists')
  for (const path of present) assert.ok(denied.includes(resolve(path)), path)
  assert.ok(!denied.includes(join(r.userHome, '.git-credentials')), 'a missing path would break every sandboxed command')
  assert.equal(new Set(denied).size, denied.length)
})

test('denied paths refuse relative roots', () => {
  assert.throws(() => reviewerDeniedPaths({ ...roots(resolve(tmpdir(), 'x')), userHome: 'relative' }, () => true), /absolute/)
})

test('the policy turns off git and gh authentication and the bypass', () => {
  const policy = reviewerSandboxPolicy(['C:\\denied'])
  assert.deepEqual(policy.sandbox.auth, { git: false, gh: false })
  assert.equal(policy.sandbox.allowBypass, false)
  assert.equal(policy.sandbox.enabled, true)
  assert.deepEqual(policy.sandbox.userPolicy.filesystem.deniedPaths, ['C:\\denied'])
})

test('read-only paths are absolute, listed only when given, and part of what is verified', async () => {
  assert.equal('readonlyPaths' in reviewerSandboxPolicy([]).sandbox.userPolicy.filesystem, false)
  assert.throws(() => reviewerSandboxPolicy([], ['node_modules']), /absolute/)
  const base = await mkdtemp(join(tmpdir(), 'reviewer-readonly-'))
  try {
    const home = join(base, 'home'), modules = join(base, 'repo', 'node_modules')
    await writeReviewerHome(home, [home], [modules])
    await verifyReviewerHome(home, [home], [modules])
    await assert.rejects(verifyReviewerHome(home, [home]), /changed/)
    await assert.rejects(verifyReviewerHome(home, [home], [modules, join(base, 'more')]), /changed/)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('a written reviewer home verifies, and every loosening is refused', async () => {
  const base = await mkdtemp(join(tmpdir(), 'reviewer-home-'))
  try {
    const home = join(base, 'home'), denied = [home, join(base, 'secret')]
    await assert.rejects(verifyReviewerHome(home, denied), /missing or unreadable/)
    await writeReviewerHome(home, denied)
    await verifyReviewerHome(home, denied)
    const settings = JSON.parse(await readFile(join(home, 'settings.json'), 'utf8'))
    // Unrelated settings the person adds are fine.
    await writeFile(join(home, 'settings.json'), JSON.stringify({ ...settings, model: 'some-model' }))
    await verifyReviewerHome(home, denied)
    const loosened = [
      { ...settings.sandbox, allowBypass: true },
      { ...settings.sandbox, auth: { git: false, gh: true } },
      { ...settings.sandbox, auth: { git: true, gh: false } },
      { ...settings.sandbox, enabled: false },
      { ...settings.sandbox, userPolicy: { filesystem: { deniedPaths: [home] } } },
    ]
    for (const sandbox of loosened) {
      await writeFile(join(home, 'settings.json'), JSON.stringify({ sandbox }))
      await assert.rejects(verifyReviewerHome(home, denied), /changed/, JSON.stringify(sandbox))
    }
    for (const key of ['enableAllGithubMcpTools', 'githubMcpToolsets', 'githubMcpTools', 'enabledMcpServers']) {
      await writeFile(join(home, 'settings.json'), JSON.stringify({ ...settings, [key]: true }))
      await assert.rejects(verifyReviewerHome(home, denied), /changed/, key)
    }
    await writeFile(join(home, 'settings.json'), '{not json')
    await assert.rejects(verifyReviewerHome(home, denied), /missing or unreadable/)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('the launch sandboxes, drops built-in MCP servers and computer use, and denies edits to the home', () => {
  const home = resolve(tmpdir(), 'reviewer-home')
  const args = reviewerLaunchArguments(home)
  assert.ok(args.includes('--sandbox'))
  assert.ok(args.includes('--disable-builtin-mcps'))
  assert.equal(args[args.indexOf('--disable-mcp-server') + 1], 'computer-use')
  const deny = args[args.indexOf('--deny-tool') + 1]
  assert.equal(deny, `write(${join(home, '**')})`)
})

test('the launch environment carries no GitHub token, in any letter case, and its own empty gh folder', () => {
  const home = resolve(tmpdir(), 'reviewer-home'), gh = resolve(tmpdir(), 'reviewer-gh')
  const env = reviewerEnvironment({ PATH: 'p', GH_TOKEN: 'a', GITHUB_TOKEN: 'b', COPILOT_GITHUB_TOKEN: 'c', GH_ENTERPRISE_TOKEN: 'd',
    GITHUB_ENTERPRISE_TOKEN: 'e', gh_token: 'f', COPILOT_HOME: 'person', GH_CONFIG_DIR: 'C:\\person\\gh', gh_config_dir: 'x', OTHER: 'kept' }, home, gh)
  assert.deepEqual(Object.keys(env).sort(), ['COPILOT_HOME', 'GH_CONFIG_DIR', 'OTHER', 'PATH'])
  assert.equal(env.COPILOT_HOME, home)
  assert.equal(env.GH_CONFIG_DIR, gh)
  assert.equal(env.OTHER, 'kept')
  assert.throws(() => reviewerEnvironment({}, home, 'relative'), /absolute/)
  assert.throws(() => reviewerEnvironment({}, home, join(home, 'gh')), /outside the reviewer home/, 'the home is denied, so gh could not use it')
})

test('the gh folder in use is denied, whether GH_CONFIG_DIR or XDG_CONFIG_HOME chose it', () => {
  const base = resolve(tmpdir(), 'reviewer-gh-roots'), r = roots(base)
  const custom = join(r.userHome, 'my-gh'), xdg = join(r.userHome, 'xdg')
  const present = new Set([custom, join(xdg, 'gh'), join(r.appData, 'GitHub CLI')])
  const denied = reviewerDeniedPaths({ ...r, environment: { GH_CONFIG_DIR: custom, XDG_CONFIG_HOME: xdg } }, (path) => present.has(path))
  for (const path of present) assert.ok(denied.includes(resolve(path)), path)
  assert.deepEqual(githubCliConfigDirectories({ userHome: r.userHome, appData: null, environment: { GH_CONFIG_DIR: 'relative' } }), [resolve(join(r.userHome, '.config', 'gh'))],
    'a relative setting is ignored, the default stays')
  assert.throws(() => reviewerDeniedPaths({ ...r, reviewerHome: r.userHome }, () => true), /its own folder/)
})

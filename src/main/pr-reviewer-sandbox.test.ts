import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { reviewerDeniedPaths, reviewerEnvironment, reviewerLaunchArguments, reviewerSandboxPolicy, verifyReviewerHome, writeReviewerHome } from './pr-reviewer-sandbox.js'

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

test('the launch sandboxes, drops built-in MCP servers and denies edits to the home', () => {
  const home = resolve(tmpdir(), 'reviewer-home')
  const args = reviewerLaunchArguments(home)
  assert.ok(args.includes('--sandbox'))
  assert.ok(args.includes('--disable-builtin-mcps'))
  const deny = args[args.indexOf('--deny-tool') + 1]
  assert.equal(deny, `write(${join(home, '**')})`)
})

test('the launch environment carries no GitHub token, in any letter case', () => {
  const home = resolve(tmpdir(), 'reviewer-home')
  const env = reviewerEnvironment({ PATH: 'p', GH_TOKEN: 'a', GITHUB_TOKEN: 'b', COPILOT_GITHUB_TOKEN: 'c', GH_ENTERPRISE_TOKEN: 'd',
    GITHUB_ENTERPRISE_TOKEN: 'e', gh_token: 'f', COPILOT_HOME: 'person', OTHER: 'kept' }, home)
  assert.deepEqual(Object.keys(env).sort(), ['COPILOT_HOME', 'OTHER', 'PATH'])
  assert.equal(env.COPILOT_HOME, home)
  assert.equal(env.OTHER, 'kept')
})

import assert from 'node:assert/strict'
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import {
  cliHasExplicitEnvOverride,
  cliSkillsLocations,
  MANAGED_SKILL_MARKER_FILE,
  PR_WORKFLOW_SKILL_NAMES,
  provisionExistingCliPrWorkflowSkills,
  provisionPrWorkflowSkillsForCli,
} from './pr-workflow-skills.js'
import { SESSION_CLIS } from './session-cli.js'

const BUNDLED_PR_TOOLS = resolve('resources', 'pr-workflows')

test('provisions review-pr, fix-pr, and review-and-fix-pr across Copilot, Claude, Codex, and Antigravity', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pr-workflow-skills-'))
  t.after(() => rm(root, { recursive: true, force: true }))

  const env: NodeJS.ProcessEnv = {
    COPILOT_HOME: join(root, 'copilot-home'),
    CLAUDE_CONFIG_DIR: join(root, 'claude-home'),
    CODEX_HOME: join(root, 'codex-home'),
    ANTIGRAVITY_GEMINI_DIR: join(root, 'gemini-home'),
  }

  for (const cli of SESSION_CLIS) {
    await provisionPrWorkflowSkillsForCli(cli, BUNDLED_PR_TOOLS, env, root)
    const { skillsDir } = cliSkillsLocations(cli, env, root)
    for (const skillName of PR_WORKFLOW_SKILL_NAMES) {
      const expected = await readFile(join(BUNDLED_PR_TOOLS, 'skills', skillName, 'SKILL.md'), 'utf8')
      const actual = await readFile(join(skillsDir, skillName, 'SKILL.md'), 'utf8')
      assert.equal(actual, expected, `${cli} receives ${skillName}/SKILL.md`)
      const marker = JSON.parse(await readFile(join(skillsDir, skillName, MANAGED_SKILL_MARKER_FILE), 'utf8'))
      assert.equal(marker.managedBy, 'copilot-cli-desktop')
      assert.equal(marker.skill, skillName)
      assert.match(marker.sha256, /^[a-f0-9]{64}$/)
    }
  }

  assert.equal(
    cliSkillsLocations('antigravity', env, root).skillsDir,
    join(root, 'gemini-home', 'config', 'skills'),
    'Antigravity uses <gemini>/config/skills',
  )
})

test('backs up pre-existing unmanaged skills outside skills/, removes stale helper scripts, and preserves later user edits', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pr-workflow-skills-upgrade-'))
  t.after(() => rm(root, { recursive: true, force: true }))

  const fakeTools = join(root, 'bundled-v1')
  for (const skillName of PR_WORKFLOW_SKILL_NAMES) {
    await mkdir(join(fakeTools, 'skills', skillName), { recursive: true })
    await writeFile(join(fakeTools, 'skills', skillName, 'SKILL.md'), `---\nname: ${skillName}\n---\n# Desktop v1 ${skillName}\n`, 'utf8')
  }

  const codexHome = join(root, 'codex-home')
  const legacyReviewDir = join(codexHome, 'skills', 'review-pr')
  await mkdir(join(legacyReviewDir, 'scripts'), { recursive: true })
  await mkdir(join(legacyReviewDir, 'agents'), { recursive: true })
  await writeFile(join(legacyReviewDir, 'SKILL.md'), '# Legacy GitHub-only review-pr\n', 'utf8')
  await writeFile(join(legacyReviewDir, 'scripts', 'pr_supervisor.py'), 'print("legacy")\n', 'utf8')
  await writeFile(join(legacyReviewDir, 'agents', 'openai.yaml'), 'name: legacy\n', 'utf8')

  const env: NodeJS.ProcessEnv = { CODEX_HOME: codexHome }
  await provisionPrWorkflowSkillsForCli('codex', fakeTools, env, root)

  // Legacy files were backed up outside `skills/` so Codex does not scan backup folders as duplicate skills.
  const backupDir = join(codexHome, '.copilot-desktop-skill-backups', 'review-pr')
  assert.equal(await readFile(join(backupDir, 'SKILL.md'), 'utf8'), '# Legacy GitHub-only review-pr\n')
  assert.equal(await readFile(join(backupDir, 'scripts', 'pr_supervisor.py'), 'utf8'), 'print("legacy")\n')
  assert.equal(await readFile(join(backupDir, 'agents', 'openai.yaml'), 'utf8'), 'name: legacy\n')
  assert.ok(!(await readdir(join(codexHome, 'skills'))).some((entry) => entry.includes('backup')), 'no backup inside skills/')

  // Stale legacy subdirectories inside skills/review-pr were cleaned out.
  const installedEntries = (await readdir(legacyReviewDir)).sort()
  assert.deepEqual(installedEntries, [MANAGED_SKILL_MARKER_FILE, 'SKILL.md'])
  assert.match(await readFile(join(legacyReviewDir, 'SKILL.md'), 'utf8'), /Desktop v1 review-pr/)

  // User hand-edits fix-pr after Desktop installed it; Desktop upgrades to v2 -> review-pr updates, fix-pr stays untouched.
  const fixSkillFile = join(codexHome, 'skills', 'fix-pr', 'SKILL.md')
  await writeFile(fixSkillFile, '---\nname: fix-pr\n---\n# User customized fix-pr\n', 'utf8')

  const fakeToolsV2 = join(root, 'bundled-v2')
  for (const skillName of PR_WORKFLOW_SKILL_NAMES) {
    await mkdir(join(fakeToolsV2, 'skills', skillName), { recursive: true })
    await writeFile(join(fakeToolsV2, 'skills', skillName, 'SKILL.md'), `---\nname: ${skillName}\n---\n# Desktop v2 ${skillName}\n`, 'utf8')
  }

  await provisionPrWorkflowSkillsForCli('codex', fakeToolsV2, env, root)
  assert.match(await readFile(join(legacyReviewDir, 'SKILL.md'), 'utf8'), /Desktop v2 review-pr/, 'unmodified Desktop skill updates to v2')
  assert.match(await readFile(join(codexHome, 'skills', 'review-and-fix-pr', 'SKILL.md'), 'utf8'), /Desktop v2 review-and-fix-pr/)
  assert.equal(await readFile(fixSkillFile, 'utf8'), '---\nname: fix-pr\n---\n# User customized fix-pr\n', 'user hand-edit is preserved')
  assert.equal(await readFile(join(backupDir, 'SKILL.md'), 'utf8'), '# Legacy GitHub-only review-pr\n', 'original backup is never overwritten')
})

test('replaces symlinked skill folder safely without modifying or deleting external target files', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pr-workflow-skills-symlink-'))
  t.after(() => rm(root, { recursive: true, force: true }))

  const externalRepoSkill = join(root, 'external-repo', 'review-pr')
  await mkdir(externalRepoSkill, { recursive: true })
  await writeFile(join(externalRepoSkill, 'SKILL.md'), '# External symlinked skill\n', 'utf8')
  await writeFile(join(externalRepoSkill, 'keep-me.txt'), 'important external file\n', 'utf8')

  const claudeHome = join(root, 'claude-home')
  await mkdir(join(claudeHome, 'skills'), { recursive: true })
  await symlink(
    externalRepoSkill,
    join(claudeHome, 'skills', 'review-pr'),
    process.platform === 'win32' ? 'junction' : 'dir',
  )

  await provisionPrWorkflowSkillsForCli('claude', BUNDLED_PR_TOOLS, { CLAUDE_CONFIG_DIR: claudeHome }, root)

  // External target directory must remain 100% untouched.
  assert.equal(await readFile(join(externalRepoSkill, 'SKILL.md'), 'utf8'), '# External symlinked skill\n')
  assert.equal(await readFile(join(externalRepoSkill, 'keep-me.txt'), 'utf8'), 'important external file\n')

  // Installed skill is now a real directory with Desktop's SKILL.md.
  const installedStat = await lstat(join(claudeHome, 'skills', 'review-pr'))
  assert.equal(installedStat.isSymbolicLink(), false)
  assert.equal(installedStat.isDirectory(), true)
  assert.equal(
    await readFile(join(claudeHome, 'skills', 'review-pr', 'SKILL.md'), 'utf8'),
    await readFile(join(BUNDLED_PR_TOOLS, 'skills', 'review-pr', 'SKILL.md'), 'utf8'),
  )
})

test('provisionExistingCliPrWorkflowSkills only provisions CLIs whose config directory already exists and handles concurrent calls', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pr-workflow-skills-existing-'))
  t.after(() => rm(root, { recursive: true, force: true }))

  const claudeHome = join(root, '.claude')
  const copilotHome = join(root, '.copilot')
  await mkdir(claudeHome, { recursive: true })
  await mkdir(copilotHome, { recursive: true })

  const env: NodeJS.ProcessEnv = {
    COPILOT_HOME: copilotHome,
    CLAUDE_CONFIG_DIR: claudeHome,
    CODEX_HOME: join(root, '.codex-missing'),
    ANTIGRAVITY_GEMINI_DIR: join(root, '.gemini-missing'),
  }

  await Promise.all([
    provisionExistingCliPrWorkflowSkills(BUNDLED_PR_TOOLS, env, root),
    provisionPrWorkflowSkillsForCli('claude', BUNDLED_PR_TOOLS, env, root),
    provisionPrWorkflowSkillsForCli('claude', BUNDLED_PR_TOOLS, env, root),
  ])

  for (const skillName of PR_WORKFLOW_SKILL_NAMES) {
    assert.ok((await stat(join(claudeHome, 'skills', skillName, 'SKILL.md'))).isFile())
    assert.ok((await stat(join(copilotHome, 'skills', skillName, 'SKILL.md'))).isFile())
  }
  await assert.rejects(stat(join(root, '.codex-missing')), { code: 'ENOENT' })
  await assert.rejects(stat(join(root, '.gemini-missing')), { code: 'ENOENT' })
})

test('allocates suffixed backup paths on repeated unmanaged replacements and supports onlyExplicitEnvOverrides', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pr-workflow-skills-multi-backup-'))
  t.after(() => rm(root, { recursive: true, force: true }))

  const codexHome = join(root, 'codex-home')
  const reviewDir = join(codexHome, 'skills', 'review-pr')
  await mkdir(reviewDir, { recursive: true })
  await writeFile(join(reviewDir, 'SKILL.md'), '# First unmanaged install\n', 'utf8')
  await writeFile(join(reviewDir, 'helper-a.py'), 'a = 1\n', 'utf8')

  await provisionPrWorkflowSkillsForCli('codex', BUNDLED_PR_TOOLS, { CODEX_HOME: codexHome }, root)
  assert.equal(await readFile(join(codexHome, '.copilot-desktop-skill-backups', 'review-pr', 'SKILL.md'), 'utf8'), '# First unmanaged install\n')

  // Simulate user replacing skills/review-pr with a brand-new unmanaged directory (no .copilot-desktop-managed.json).
  await rm(reviewDir, { recursive: true, force: true })
  await mkdir(reviewDir, { recursive: true })
  await writeFile(join(reviewDir, 'SKILL.md'), '# Second unmanaged install\n', 'utf8')
  await writeFile(join(reviewDir, 'helper-b.py'), 'b = 2\n', 'utf8')

  await provisionPrWorkflowSkillsForCli('codex', BUNDLED_PR_TOOLS, { CODEX_HOME: codexHome }, root)
  assert.equal(
    await readFile(join(codexHome, '.copilot-desktop-skill-backups', 'review-pr', 'SKILL.md'), 'utf8'),
    '# First unmanaged install\n',
    'first backup remains untouched',
  )
  assert.equal(
    await readFile(join(codexHome, '.copilot-desktop-skill-backups', 'review-pr-2', 'SKILL.md'), 'utf8'),
    '# Second unmanaged install\n',
    'second unmanaged replacement is backed up to review-pr-2 instead of being deleted unbacked',
  )
  assert.equal(
    await readFile(join(codexHome, '.copilot-desktop-skill-backups', 'review-pr-2', 'helper-b.py'), 'utf8'),
    'b = 2\n',
  )

  // Verify onlyExplicitEnvOverrides leaves non-overridden home directories untouched.
  const hostHome = join(root, 'host-home')
  await mkdir(join(hostHome, '.claude'), { recursive: true })
  await mkdir(join(hostHome, '.copilot'), { recursive: true })
  assert.equal(cliHasExplicitEnvOverride('copilot', { COPILOT_HOME: join(hostHome, '.copilot') }), true)
  assert.equal(cliHasExplicitEnvOverride('claude', { COPILOT_HOME: join(hostHome, '.copilot') }), false)

  await provisionExistingCliPrWorkflowSkills(
    BUNDLED_PR_TOOLS,
    { COPILOT_HOME: join(hostHome, '.copilot') },
    hostHome,
    { onlyExplicitEnvOverrides: true },
  )
  assert.ok((await stat(join(hostHome, '.copilot', 'skills', 'review-and-fix-pr', 'SKILL.md'))).isFile())
  await assert.rejects(stat(join(hostHome, '.claude', 'skills')), { code: 'ENOENT' })
})

test('every bundled skill ships a SKILL.md named after it, and review-meeting names both channels to the desktop', async () => {
  const skills = resolve('resources/pr-workflows/skills')
  assert.deepEqual((await readdir(skills)).sort(), [...PR_WORKFLOW_SKILL_NAMES].sort(), 'the folder and the list of provisioned skills are the same')
  for (const name of PR_WORKFLOW_SKILL_NAMES) {
    const text = await readFile(join(skills, name, 'SKILL.md'), 'utf8')
    assert.match(text, new RegExp(`^---\r?\nname: ${name}\r?\ndescription: .+\r?\nuser-invocable: true\r?\n---`), `${name} has the frontmatter a CLI needs to find it`)
  }
  const meeting = await readFile(join(skills, 'review-meeting', 'SKILL.md'), 'utf8')
  // The tools for a session that has them, the helper for one that does not: each way to ask for hidden reviewers.
  assert.match(meeting, /meeting_start\(\{[^)]*reviewers: true/)
  assert.match(meeting, /start -Topic "<one line>" -File <that file> -Reviewers/)
  assert.match(meeting, /COPILOT_DESKTOP_MEETING_HELPER/)
  // What the host must not do, and what it must tell the person.
  assert.match(meeting, /Never start reviewer CLIs yourself/)
  assert.match(meeting, /Tell the person the meeting id at once/)
  assert.match(meeting, /\*\*Peek\*\*, \*\*Retry\*\* and \*\*Dismiss\*\*/)
})

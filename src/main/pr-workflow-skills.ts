import { createHash, randomUUID } from 'node:crypto'
import { cp, lstat, mkdir, readdir, readFile, readlink, rm, stat, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { writeFileAtomic } from './atomic-file.js'
import { SESSION_CLIS, type SessionCli } from './session-cli.js'

/** The skills the desktop installs for every CLI: the three pull request workflows, and the review meeting with hidden reviewers. */
export const PR_WORKFLOW_SKILL_NAMES = ['review-pr', 'fix-pr', 'review-and-fix-pr', 'review-meeting'] as const
export type PrWorkflowSkillName = (typeof PR_WORKFLOW_SKILL_NAMES)[number]

export const MANAGED_SKILL_MARKER_FILE = '.copilot-desktop-managed.json'
const MANAGED_BY = 'copilot-cli-desktop'

interface ManagedSkillMarker {
  managedBy: typeof MANAGED_BY
  skill: PrWorkflowSkillName
  sha256: string
}

export interface CliSkillsLocations {
  baseDir: string
  skillsDir: string
  backupsDir: string
}

export function cliHasExplicitEnvOverride(cli: SessionCli, env: NodeJS.ProcessEnv = process.env): boolean {
  if (cli === 'copilot') return Boolean(env.COPILOT_HOME?.trim())
  if (cli === 'claude') return Boolean(env.CLAUDE_CONFIG_DIR?.trim())
  if (cli === 'codex') return Boolean(env.CODEX_HOME?.trim())
  return Boolean(env.ANTIGRAVITY_GEMINI_DIR?.trim())
}

function sha256Hex(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

function normalizeLockKey(path: string): string {
  const resolved = resolve(path)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

export function cliSkillsLocations(
  cli: SessionCli,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): CliSkillsLocations {
  if (cli === 'copilot') {
    const baseDir = resolve(env.COPILOT_HOME || join(home, '.copilot'))
    return {
      baseDir,
      skillsDir: join(baseDir, 'skills'),
      backupsDir: join(baseDir, '.copilot-desktop-skill-backups'),
    }
  }
  if (cli === 'claude') {
    const baseDir = resolve(env.CLAUDE_CONFIG_DIR || join(home, '.claude'))
    return {
      baseDir,
      skillsDir: join(baseDir, 'skills'),
      backupsDir: join(baseDir, '.copilot-desktop-skill-backups'),
    }
  }
  if (cli === 'codex') {
    const baseDir = resolve(env.CODEX_HOME || join(home, '.codex'))
    return {
      baseDir,
      skillsDir: join(baseDir, 'skills'),
      backupsDir: join(baseDir, '.copilot-desktop-skill-backups'),
    }
  }
  const baseDir = resolve(env.ANTIGRAVITY_GEMINI_DIR || join(home, '.gemini'))
  return {
    baseDir,
    skillsDir: join(baseDir, 'config', 'skills'),
    backupsDir: join(baseDir, '.copilot-desktop-skill-backups'),
  }
}

async function readManagedMarker(markerPath: string): Promise<ManagedSkillMarker | null> {
  try {
    const raw = await readFile(markerPath, 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (
      typeof parsed === 'object'
      && parsed !== null
      && !Array.isArray(parsed)
      && (parsed as { managedBy?: unknown }).managedBy === MANAGED_BY
      && typeof (parsed as { sha256?: unknown }).sha256 === 'string'
      && /^[a-f0-9]{64}$/.test((parsed as { sha256: string }).sha256)
      && typeof (parsed as { skill?: unknown }).skill === 'string'
    ) {
      return parsed as ManagedSkillMarker
    }
  } catch {
    // Missing or unreadable marker means not managed by Desktop yet.
  }
  return null
}

async function writeManagedSkill(
  skillDir: string,
  skillName: PrWorkflowSkillName,
  sourceContent: string,
  sourceSha256: string,
): Promise<void> {
  await mkdir(skillDir, { recursive: true })
  const marker: ManagedSkillMarker = {
    managedBy: MANAGED_BY,
    skill: skillName,
    sha256: sourceSha256,
  }
  await writeFileAtomic(join(skillDir, 'SKILL.md'), sourceContent)
  await writeFileAtomic(join(skillDir, MANAGED_SKILL_MARKER_FILE), `${JSON.stringify(marker, null, 2)}\n`)
}

async function allocateBackupPath(backupsDir: string, baseName: string): Promise<string> {
  const firstCandidate = join(backupsDir, baseName)
  const firstStat = await lstat(firstCandidate).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (!firstStat) return firstCandidate

  for (let suffix = 2; suffix <= 1000; suffix += 1) {
    const candidate = join(backupsDir, `${baseName}-${suffix}`)
    const candidateStat = await lstat(candidate).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null
      throw error
    })
    if (!candidateStat) return candidate
  }
  return join(backupsDir, `${baseName}-${randomUUID()}`)
}

async function provisionSingleSkill(
  locations: CliSkillsLocations,
  skillName: PrWorkflowSkillName,
  prToolsDir: string,
): Promise<void> {
  const sourcePath = join(prToolsDir, 'skills', skillName, 'SKILL.md')
  const sourceContent = await readFile(sourcePath, 'utf8')
  const sourceSha256 = sha256Hex(sourceContent)
  const skillDir = join(locations.skillsDir, skillName)
  const existingStat = await lstat(skillDir).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null
    throw error
  })

  if (!existingStat) {
    await writeManagedSkill(skillDir, skillName, sourceContent, sourceSha256)
    return
  }

  if (existingStat.isSymbolicLink()) {
    const target = await readlink(skillDir).catch(() => '')
    if (target) {
      const symlinkBackupDir = await allocateBackupPath(locations.backupsDir, skillName)
      await mkdir(symlinkBackupDir, { recursive: true })
      await writeFileAtomic(join(symlinkBackupDir, 'symlink-target.txt'), `${target}\n`)
    }
    await unlink(skillDir)
    await writeManagedSkill(skillDir, skillName, sourceContent, sourceSha256)
    return
  }

  if (!existingStat.isDirectory()) {
    await mkdir(locations.backupsDir, { recursive: true })
    const fileBackupPath = await allocateBackupPath(locations.backupsDir, `${skillName}.bak`)
    await cp(skillDir, fileBackupPath)
    await rm(skillDir, { force: true })
    await writeManagedSkill(skillDir, skillName, sourceContent, sourceSha256)
    return
  }

  const markerPath = join(skillDir, MANAGED_SKILL_MARKER_FILE)
  const skillFilePath = join(skillDir, 'SKILL.md')
  const [marker, existingContent] = await Promise.all([
    readManagedMarker(markerPath),
    readFile(skillFilePath, 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null
      throw error
    }),
  ])

  if (marker) {
    if (existingContent === sourceContent && marker.sha256 === sourceSha256) {
      return
    }
    if (
      existingContent !== null
      && existingContent !== sourceContent
      && sha256Hex(existingContent) !== marker.sha256
    ) {
      // Preserve intentional user edits made to a Desktop-provisioned skill.
      return
    }
    await writeManagedSkill(skillDir, skillName, sourceContent, sourceSha256)
    return
  }

  // Pre-existing directory without a Desktop marker (e.g. an older GitHub-only review-pr/fix-pr install):
  // back it up to a non-colliding path outside `skills/` so no CLI loads the backup as a duplicate skill
  // and no user files are ever deleted unbacked, then install Desktop's forge-agnostic skill.
  const entries = await readdir(skillDir).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return [] as string[]
    throw error
  })
  if (entries.length > 0 && !(entries.length === 1 && entries[0] === 'SKILL.md' && existingContent === sourceContent)) {
    await mkdir(locations.backupsDir, { recursive: true })
    const backupDir = await allocateBackupPath(locations.backupsDir, skillName)
    await cp(skillDir, backupDir, { recursive: true, verbatimSymlinks: true })
    await rm(skillDir, { recursive: true, force: true })
  }
  await writeManagedSkill(skillDir, skillName, sourceContent, sourceSha256)
}

const inFlightBySkillsDir = new Map<string, Promise<void>>()

/**
 * Ensures `review-pr`, `fix-pr`, and `review-and-fix-pr` from `prToolsDir/skills` are provisioned in `cli`'s global
 * user skills directory so slash commands and `Skill(...)` invocations work across Copilot CLI, Claude Code, Codex CLI,
 * and Antigravity CLI.
 */
export function provisionPrWorkflowSkillsForCli(
  cli: SessionCli,
  prToolsDir: string,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): Promise<void> {
  const locations = cliSkillsLocations(cli, env, home)
  const key = normalizeLockKey(locations.skillsDir)
  const previous = inFlightBySkillsDir.get(key) ?? Promise.resolve()
  const run = previous.catch(() => {}).then(async () => {
    for (const skillName of PR_WORKFLOW_SKILL_NAMES) {
      await provisionSingleSkill(locations, skillName, prToolsDir)
    }
  })
  inFlightBySkillsDir.set(key, run)
  return run.finally(() => {
    if (inFlightBySkillsDir.get(key) === run) {
      inFlightBySkillsDir.delete(key)
    }
  })
}

/**
 * At Desktop startup, provisions the 3 PR workflow skills into every CLI config directory that already exists on disk,
 * without creating config directories for CLIs the user has never installed.
 */
export async function provisionExistingCliPrWorkflowSkills(
  prToolsDir: string,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
  options: { onlyExplicitEnvOverrides?: boolean } = {},
): Promise<void> {
  await Promise.all(SESSION_CLIS.map(async (cli) => {
    if (options.onlyExplicitEnvOverrides && !cliHasExplicitEnvOverride(cli, env)) return
    const { baseDir } = cliSkillsLocations(cli, env, home)
    const exists = await stat(baseDir).then((info) => info.isDirectory(), () => false)
    if (!exists) return
    await provisionPrWorkflowSkillsForCli(cli, prToolsDir, env, home)
  }))
}

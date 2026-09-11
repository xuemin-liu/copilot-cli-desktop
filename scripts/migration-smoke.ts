// Isolated source → destination round trip, including the production usage worker.
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MigrationService } from '../src/main/migration-service.js'
import { UsageService } from '../src/main/usage-service.js'
import { seedSourceStore } from './usage-source-fixture.js'
import { createWorkspaceProfile, DEFAULT_DESKTOP_CONFIG, writeDesktopConfig } from '../src/main/desktop-config.js'
import type { MigrationRoots } from '../src/main/migration-types.js'

const root = await mkdtemp(join(tmpdir(), 'copilot-migration-smoke-'))
const services: UsageService[] = []
try {
  const roots = (name: string): MigrationRoots => ({ copilot: join(root, name, 'copilot'), desktop: join(root, name, 'desktop'), agentSkills: join(root, name, 'home', '.agents', 'skills') })
  const source = roots('source'), destination = roots('destination')
  for (const path of [...Object.values(source), ...Object.values(destination)]) await mkdir(path, { recursive: true })
  const oldWorkspace = join(root, 'source', 'repo'), newWorkspace = join(root, 'destination', 'repo')
  await mkdir(oldWorkspace); await mkdir(newWorkspace)
  await writeFile(join(oldWorkspace, 'AGENTS.md'), 'Migration smoke project instructions')
  const profile = createWorkspaceProfile(oldWorkspace)
  await writeDesktopConfig(join(source.desktop, 'desktop.json'), { ...DEFAULT_DESKTOP_CONFIG, profiles: [profile] })
  await writeFile(join(source.copilot, 'settings.json'), '{"theme":"dim","model":"smoke-model"}')
  await writeFile(join(destination.copilot, 'settings.json'), '{"model":"local-model"}')
  seedSourceStore(source.copilot, 'migration-source'); seedSourceStore(destination.copilot, 'migration-destination')
  async function service(paths: MigrationRoots): Promise<MigrationService> {
    const usage = new UsageService(join(paths.desktop, 'usage.sqlite'), paths.copilot, console.error)
    services.push(usage); await usage.collect()
    return new MigrationService({ roots: paths, appVersion: 'smoke', cliVersion: () => '1.0.82', assertIdle: async () => {}, plugins: async () => ({ plugins: [] }),
      exportUsage: (path) => usage.exportTo(path), restoreUsage: (path) => usage.restoreFrom(path), progress: () => {}, reloaded: async () => {} })
  }
  const sender = await service(source), receiver = await service(destination)
  const path = join(root, 'migration.zip')
  await sender.export(path, { categories: ['settings', 'desktop', 'projects', 'usage'], projectIds: [profile.id] })
  await receiver.open(path); receiver.mapProject(profile.id, newWorkspace)
  const choices = { categories: ['settings', 'desktop', 'projects', 'usage'] as const, replace: [], allowPermissions: false }
  const preview = await receiver.preview({ ...choices, categories: [...choices.categories] })
  const result = await receiver.apply(preview.id)
  assert.ok(result.backup)
  assert.equal(JSON.parse(await readFile(join(destination.copilot, 'settings.json'), 'utf8')).model, 'local-model')
  assert.equal(await readFile(join(newWorkspace, 'AGENTS.md'), 'utf8'), 'Migration smoke project instructions')
  assert.equal((await services[1]!.report('2026-09', 'all', 'UTC')).totals.input, 100)
  assert.ok(result.warnings.includes('Usage records merged successfully.'))
  const again = await receiver.preview({ ...choices, categories: [...choices.categories] })
  await receiver.apply(again.id)
  assert.equal((await services[1]!.report('2026-09', 'all', 'UTC')).totals.input, 100)
  console.log('[migration-smoke] Export/import, workspace mapping, destination preservation, usage merge and repeated import passed.')
} finally {
  await Promise.all(services.map((service) => service.stop()))
  await rm(root, { recursive: true, force: true })
}

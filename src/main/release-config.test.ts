import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

interface PackageBuildConfig {
  scripts?: Record<string, unknown>
  build?: {
    electronFuses?: Record<string, unknown>
    files?: unknown[]
    publish?: Array<{ provider?: unknown; owner?: unknown; repo?: unknown }>
    nsis?: { artifactName?: unknown }
  }
}

test('release configuration keeps the GitHub updater feed, asset name, and package audit aligned', async () => {
  const manifest = JSON.parse(await readFile('package.json', 'utf8')) as PackageBuildConfig
  assert.deepEqual(manifest.build?.publish, [{
    provider: 'github',
    owner: 'xuemin-liu',
    repo: 'copilot-cli-desktop',
  }])
  assert.equal(manifest.build?.nsis?.artifactName, 'Copilot-CLI-Desktop-Setup-${version}.${ext}')
  assert.match(String(manifest.scripts?.['pack:win']), /audit-package/)
  assert.match(String(manifest.scripts?.['pack:win']), /package-smoke/)
  assert.match(String(manifest.scripts?.['dist:win']), /audit-package/)
  assert.match(String(manifest.scripts?.['dist:win']), /package-smoke/)
  assert.match(String(manifest.scripts?.['dist:win']), /--publish never/)
  assert.deepEqual(manifest.build?.electronFuses, {
    runAsNode: false,
    enableCookieEncryption: true,
    enableNodeOptionsEnvironmentVariable: false,
    enableNodeCliInspectArguments: false,
    enableEmbeddedAsarIntegrityValidation: true,
    onlyLoadAppFromAsar: true,
    loadBrowserProcessSpecificV8Snapshot: false,
    grantFileProtocolExtraPrivileges: true,
  })
  assert.ok(manifest.build?.files?.includes('!dist/**/*.test.js'))
  assert.ok(manifest.build?.files?.includes('!dist/**/*.map'))
})

test('release workflow refuses to publish an unsigned Windows installer', async () => {
  const workflow = await readFile('.github/workflows/release.yml', 'utf8')
  assert.match(workflow, /WINDOWS_CSC_LINK is required/)
  assert.match(workflow, /Get-AuthenticodeSignature/)
  assert.doesNotMatch(workflow, /publishing an unsigned release/)
  assert.doesNotMatch(workflow, /uses:\s+[^\s]+@v\d/)
})

test('latest Copilot CLI compatibility is exercised on a schedule', async () => {
  const workflow = await readFile('.github/workflows/cli-compatibility.yml', 'utf8')
  assert.match(workflow, /schedule:/)
  assert.match(workflow, /npm install --global @github\/copilot@latest/)
  assert.match(workflow, /pnpm smoke/)
  assert.match(workflow, /pnpm cli:smoke/)
})

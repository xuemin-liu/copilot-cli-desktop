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

test('release workflows build on GitHub, attest their files and leave publishing to a person', async () => {
  const workflow = await readFile('.github/workflows/release.yml', 'utf8')
  const unix = await readFile('.github/workflows/release-unix.yml', 'utf8')
  // An unsigned installer is released only as a draft, after its signature status and update metadata are checked.
  assert.match(workflow, /draft: true/)
  assert.doesNotMatch(workflow, /draft: false/)
  assert.match(workflow, /Get-AuthenticodeSignature/)
  assert.match(workflow, /'Valid' } else { 'NotSigned' }/)
  assert.match(workflow, /latest\.yml does not contain/)
  // The build job cannot write to the repository. Only a pushed tag publishes or signs, never a manual run on a tag, and a
  // published release is never changed in place.
  assert.match(workflow, /^permissions:\r?\n {2}contents: read\r?\n/m)
  assert.match(workflow, /publish:\r?\n {4}needs: build\r?\n {4}if: github\.event_name == 'push' && github\.ref_type == 'tag'\r?\n/)
  assert.doesNotMatch(workflow, /github\.ref_type == 'tag' && secrets\./)
  assert.match(workflow, /Refuse to change a published release/)
  assert.match(workflow, /Could not list releases to check/)
  // A manual macOS/Linux run must start on the tag it builds, because its attestation records the run's own commit.
  assert.match(unix, /"\$GITHUB_REF" != "refs\/tags\/\$RELEASE_TAG"/)
  // A failed command in a multi-line PowerShell step fails the step, not just the last command.
  assert.match(workflow, /\$PSNativeCommandUseErrorActionPreference = \$true\r?\n {10}corepack pnpm typecheck/)
  for (const file of [workflow, unix]) {
    assert.match(file, /uses: actions\/attest@[0-9a-f]{40}/)
    assert.doesNotMatch(file, /uses:\s+[^\s]+@v\d/)
  }
})



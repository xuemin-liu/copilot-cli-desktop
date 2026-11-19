import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { configureAntigravityMeetingMcp } from './antigravity-mcp.js'

test('provisions and refreshes a Desktop-managed Antigravity server alongside other servers', async (t) => {
  const gemini = await mkdtemp(join(tmpdir(), 'antigravity-mcp-'))
  t.after(() => rm(gemini, { recursive: true, force: true }))
  const configPath = join(gemini, 'config', 'mcp_config.json')
  await configureAntigravityMeetingMcp('http://127.0.0.1:1234/mcp', gemini)
  const config = JSON.parse(await readFile(configPath, 'utf8'))
  assert.equal(config.mcpServers['copilot-meeting'].serverUrl, 'http://127.0.0.1:1234/mcp?source=copilot-cli-desktop')
  config.mcpServers.other = { command: 'another-tool', args: ['--example'] }
  await writeFile(configPath, JSON.stringify(config))
  await configureAntigravityMeetingMcp('http://127.0.0.1:5678/mcp', gemini)
  assert.deepEqual(JSON.parse(await readFile(configPath, 'utf8')), { mcpServers: {
    'copilot-meeting': { serverUrl: 'http://127.0.0.1:5678/mcp?source=copilot-cli-desktop' },
    other: config.mcpServers.other,
  } })
  const userConfig = '{"mcpServers":{"copilot-meeting":{"serverUrl":"http://localhost:1324/mcp","disabled":true}}}'
  await writeFile(configPath, userConfig)
  await configureAntigravityMeetingMcp('http://127.0.0.1:5678/mcp', gemini)
  assert.equal(await readFile(configPath, 'utf8'), userConfig, 'the user-configured entry is preserved byte for byte')
})

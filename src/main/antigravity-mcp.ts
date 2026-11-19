import { readFile, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { applyEdits, modify } from 'jsonc-parser'
import { writeFileAtomic } from './atomic-file.js'
import { GUEST_MCP_SERVER_NAME } from './meeting-guests.js'

const DESKTOP_QUERY = '?source=copilot-cli-desktop'
const MANAGED_URL = /^http:\/\/127\.0\.0\.1:\d+\/mcp\?source=copilot-cli-desktop$/

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Antigravity loads user MCP servers before its first prompt. Register this one while preserving user entries. */
export async function configureAntigravityMeetingMcp(
  endpoint: string,
  geminiDirectory = process.env.ANTIGRAVITY_GEMINI_DIR || join(homedir(), '.gemini'),
): Promise<void> {
  const configPath = join(geminiDirectory, 'config', 'mcp_config.json')
  const path = await realpath(configPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return configPath
    throw error
  })
  const source = await readFile(path, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return ''
    throw error
  })
  const json = source.replace(/^\uFEFF/, '')
  const contents = json.trim() ? json : '{}\n'
  const config: unknown = JSON.parse(contents)
  if (!object(config) || (Object.hasOwn(config, 'mcpServers') && !object(config.mcpServers))) {
    throw new Error('Antigravity MCP configuration must contain a server map')
  }
  const current = object(config.mcpServers) ? config.mcpServers[GUEST_MCP_SERVER_NAME] : undefined
  const serverUrl = endpoint + DESKTOP_QUERY
  if (current !== undefined) {
    // Only replace a URL provisioned by Desktop. Additional fields indicate a user's customization.
    if (!object(current) || typeof current.serverUrl !== 'string' || !MANAGED_URL.test(current.serverUrl)
      || current.serverUrl === serverUrl || Object.keys(current).length !== 1) return
  }
  const edits = modify(contents, ['mcpServers', GUEST_MCP_SERVER_NAME], { serverUrl }, {
    formattingOptions: { insertSpaces: true, tabSize: 2 },
  })
  await writeFileAtomic(path, applyEdits(contents, edits))
}

import { execFile, spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { promisify } from 'node:util'
import type { AgentCliResolution } from './agent-cli.js'
import { otherCliReasoningEfforts } from './agent-cli-settings.js'
import { CopilotRpc } from './copilot-rpc.js'
import { detachedGroup, killProcessTree, startProcessWatchdog } from './process-tree.js'
import { withCopilotPathAdditions } from './resolve-copilot.js'
import { REASONING_EFFORTS } from './session-launch.js'
import type { CopilotResolution } from './types.js'

export interface CliModelOption {
  id: string
  label: string
  /** An omitted list means the provider did not advertise its effort levels. */
  efforts?: string[]
}

const TIMEOUT = 15_000
const MAX_OUTPUT = 8 * 1024 * 1024
const execFileAsync = promisify(execFile)

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {}
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function modelOption(id: unknown, label: unknown, levels: unknown, allowed: readonly string[]): CliModelOption[] {
  if (typeof id !== 'string' || !id || id !== id.trim() || id.length > 200 || /^-|[\x00-\x1f\x7f]/.test(id)) return []
  const reported = list(levels)
  return [{
    id,
    label: typeof label === 'string' && label.trim() ? label.trim().slice(0, 200) : id,
    ...(Array.isArray(levels) ? { efforts: allowed.filter((effort) => reported.includes(effort)) } : {}),
  }]
}

async function inCatalogDirectory<T>(read: (cwd: string) => Promise<T>): Promise<T> {
  // Catalog queries use installed CLI/account settings without opening a workspace or PR checkout.
  const cwd = await mkdtemp(join(tmpdir(), 'copilot-desktop-models-'))
  try {
    return await read(cwd)
  } finally {
    await rm(cwd, { recursive: true, force: true }).catch(() => {})
  }
}

export async function readCopilotModelCatalog(resolution: CopilotResolution, env: NodeJS.ProcessEnv): Promise<CliModelOption[]> {
  if (resolution.version === null) return []
  if (env.COPILOT_PROVIDER_TYPE && env.COPILOT_PROVIDER_TYPE !== 'github' && env.COPILOT_MODEL) {
    return modelOption(env.COPILOT_MODEL, env.COPILOT_MODEL, undefined, [])
  }
  return inCatalogDirectory(async (cwd) => {
    const rpc = new CopilotRpc(resolution, cwd, env)
    try {
      const result = record(await rpc.request('models.list', {}, TIMEOUT))
      const efforts = REASONING_EFFORTS.filter((effort) => effort !== 'default')
      const models = list(result.models).flatMap((value) => {
        const model = record(value)
        const policy = record(model.policy)
        if (policy.state === 'disabled') return []
        return modelOption(model.id, model.name, model.supportedReasoningEfforts, efforts)
      })
      const auto = list(record(result.auto).tiers).map(record).some((tier) => (
        tier.type === 'auto' && record(tier.status).enabled === true && record(tier.status).pickerVisible !== false
      ))
      if (auto && !models.some((model) => model.id === 'auto')) models.unshift({ id: 'auto', label: 'Auto', efforts: [] })
      return models
    } finally {
      await rpc.stop()
    }
  })
}

async function readJsonLines<T>(
  resolution: AgentCliResolution,
  args: string[],
  cwd: string,
  exchange: (send: (message: object) => void, receive: () => Promise<Record<string, unknown>>) => Promise<T>,
): Promise<T> {
  const child = spawn(resolution.command, [...resolution.prefixArgs, ...args], {
    cwd, env: withCopilotPathAdditions(process.env, resolution.pathAdditions), windowsHide: true, detached: detachedGroup(),
    stdio: ['pipe', 'pipe', 'ignore'],
  })
  const watchdog = child.pid ? startProcessWatchdog(child.pid) : null
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity })
  const iterator = lines[Symbol.asyncIterator]()
  const timer = setTimeout(() => lines.close(), TIMEOUT)
  let bytes = 0
  child.stdout.on('data', (chunk: Buffer) => {
    bytes += chunk.length
    if (bytes > MAX_OUTPUT) lines.close()
  })
  child.on('error', () => lines.close())
  child.stdin.on('error', () => lines.close())
  child.once('exit', () => watchdog?.release())
  try {
    return await exchange(
      (message) => { child.stdin.write(JSON.stringify(message) + '\n') },
      async () => {
        const next = await iterator.next()
        if (next.done || bytes > MAX_OUTPUT) throw new Error('Model catalog response ended')
        return record(JSON.parse(next.value) as unknown)
      },
    )
  } finally {
    clearTimeout(timer)
    lines.close()
    child.stdin.destroy()
    if (child.pid && child.exitCode === null && child.signalCode === null) await killProcessTree(child.pid)
    watchdog?.release()
  }
}

export async function readOtherCliModelCatalog(resolution: AgentCliResolution): Promise<CliModelOption[]> {
  if (resolution.version === null) return []
  const { cli } = resolution
  const efforts = otherCliReasoningEfforts(cli)
  return inCatalogDirectory(async (cwd) => {
    if (cli === 'claude') {
      const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--strict-mcp-config', '--setting-sources', 'user']
      return readJsonLines(resolution, args, cwd, async (send, receive) => {
        // The Claude Agent SDK's initialize response includes supportedModels() before any user message.
        send({ type: 'control_request', request_id: 'models', request: { subtype: 'initialize' } })
        for (;;) {
          const message = await receive()
          const response = record(message.response)
          if (message.type !== 'control_response' || response.request_id !== 'models') continue
          if (response.subtype !== 'success') return []
          return list(record(response.response).models).flatMap((value) => {
            const model = record(value)
            if (model.value === 'default') return []
            return modelOption(model.value, model.displayName, model.supportedEffortLevels, efforts)
          })
        }
      })
    }
    if (cli === 'codex') {
      return readJsonLines(resolution, ['app-server'], cwd, async (send, receive) => {
        let id = 0
        const request = async (method: string, params: object): Promise<Record<string, unknown>> => {
          const requestId = ++id
          send({ id: requestId, method, params })
          for (;;) {
            const message = await receive()
            if (message.id !== requestId) continue
            if (message.error) throw new Error('Codex app-server model request failed')
            return record(message.result)
          }
        }
        await request('initialize', { clientInfo: { name: 'copilot_cli_desktop', title: 'Copilot CLI Desktop', version: '1.0.0' } })
        send({ method: 'initialized' })
        const models: CliModelOption[] = []
        const seen = new Set<string>()
        let cursor: string | undefined
        do {
          const page = await request('model/list', { limit: 100, includeHidden: false, cursor })
          for (const value of list(page.data)) {
            const model = record(value)
            if (model.hidden === true) continue
            const levels = Array.isArray(model.supportedReasoningEfforts)
              ? model.supportedReasoningEfforts.map((level) => record(level).reasoningEffort)
              : undefined
            models.push(...modelOption(model.model ?? model.id, model.displayName, levels, efforts))
          }
          cursor = typeof page.nextCursor === 'string' && page.nextCursor ? page.nextCursor : undefined
          if (cursor && seen.has(cursor)) break
          if (cursor) seen.add(cursor)
        } while (cursor)
        return models
      })
    }
    const { stdout } = await execFileAsync(resolution.command, [...resolution.prefixArgs, 'models'], {
      cwd, env: withCopilotPathAdditions(process.env, resolution.pathAdditions), windowsHide: true,
      timeout: TIMEOUT, maxBuffer: MAX_OUTPUT,
    })
    // agy emits one slug and label per line. The slug already identifies the thinking variant.
    return stdout.split(/\r?\n/).flatMap((line) => {
      const match = /^([a-z0-9][a-z0-9._-]*)(?:\t+| {2,})(\S.*)$/i.exec(line.trim())
      return match ? modelOption(match[1], match[2], [], []) : []
    })
  })
}

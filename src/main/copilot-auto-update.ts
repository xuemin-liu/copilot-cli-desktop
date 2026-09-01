import { readFile } from 'node:fs/promises'
import { writeFileAtomic } from './atomic-file.js'

export const COPILOT_UPDATE_CHANNELS = ['stable', 'prerelease'] as const
export type CopilotUpdateChannel = (typeof COPILOT_UPDATE_CHANNELS)[number]

export interface CopilotAutoUpdateState {
  enabled: boolean
  channel: CopilotUpdateChannel
  error: string | null
}

const MAX_SETTINGS_BYTES = 1024 * 1024

export function isCopilotUpdateChannel(value: unknown): value is CopilotUpdateChannel {
  return COPILOT_UPDATE_CHANNELS.includes(value as CopilotUpdateChannel)
}

function isMissingPath(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

function parseSettings(content: string): Record<string, unknown> {
  if (Buffer.byteLength(content, 'utf8') > MAX_SETTINGS_BYTES) {
    throw new Error('Copilot settings exceed the 1 MiB safety limit')
  }
  const parsed = JSON.parse(content) as unknown
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Copilot settings must be a JSON object')
  }
  return parsed as Record<string, unknown>
}

async function readSettingsDocument(path: string): Promise<Record<string, unknown>> {
  try {
    return parseSettings(await readFile(path, 'utf8'))
  } catch (error) {
    if (isMissingPath(error)) return {}
    throw error
  }
}

export function effectiveCopilotAutoUpdate(values: Readonly<Record<string, unknown>>): CopilotAutoUpdateState {
  return {
    enabled: values.autoUpdate !== false,
    channel: values.autoUpdatesChannel === 'prerelease' ? 'prerelease' : 'stable',
    error: null,
  }
}

export async function readCopilotAutoUpdate(path: string): Promise<CopilotAutoUpdateState> {
  try {
    return effectiveCopilotAutoUpdate(await readSettingsDocument(path))
  } catch (error) {
    return {
      enabled: true,
      channel: 'stable',
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

/** Patch only the update preferences into the latest on-disk document so
 * nested, unknown, and newly introduced Copilot settings are preserved. */
export async function writeCopilotAutoUpdate(
  path: string,
  enabled: boolean,
  channel: CopilotUpdateChannel,
): Promise<void> {
  const values = await readSettingsDocument(path)
  await writeFileAtomic(path, `${JSON.stringify({
    ...values,
    autoUpdate: enabled,
    autoUpdatesChannel: channel,
  }, null, 2)}\n`)
}

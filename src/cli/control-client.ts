import type { DaemonState, PublicDaemonState } from './runtime-state.js'

export async function sendControl(
  state: DaemonState,
  path: '/status' | '/restart' | '/stop' | '/logs',
  method: 'GET' | 'POST' = 'GET',
  timeoutMs = 5_000,
): Promise<PublicDaemonState & { logs?: string[] }> {
  const response = await fetch(`http://127.0.0.1:${state.controlPort}${path}`, {
    method,
    headers: { authorization: `Bearer ${state.token}` },
    cache: 'no-store',
    signal: AbortSignal.timeout(timeoutMs),
  })

  const body = await response.json() as PublicDaemonState & { message?: string; logs?: string[] }
  if (!response.ok) throw new Error(body.message ?? `Control request failed with HTTP ${response.status}`)
  return body
}

export async function isDaemonAlive(state: DaemonState): Promise<boolean> {
  try {
    await sendControl(state, '/status')
    return true
  } catch {
    return false
  }
}

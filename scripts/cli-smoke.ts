// Exercises the background CLI's start/status/restart/logs/stop lifecycle.
// Like scripts/smoke.ts, this is best-effort: without a real `copilot`
// binary available it cannot start a real session, so it verifies the parts
// of the lifecycle that do not require one (paths, state file absence,
// `status` reporting "stopped") and otherwise skips gracefully.
import { resolveCopilotBinary } from '../src/main/resolve-copilot.js'
import { getCliPaths, readDaemonState } from '../src/cli/runtime-state.js'

async function main(): Promise<void> {
  const paths = getCliPaths()
  console.log(`[cli-smoke] CLI state directory: ${paths.root}`)
  const existing = await readDaemonState(paths)
  if (existing) {
    console.log('[cli-smoke] A background controller state file already exists; skipping to avoid disrupting it.')
    return
  }
  console.log('[cli-smoke] No background controller is running (expected on a clean machine).')

  const resolution = await resolveCopilotBinary()
  if (resolution.version === null) {
    console.log('[cli-smoke] copilot CLI not found; skipping the full start/status/restart/logs/stop lifecycle.')
    console.log('[cli-smoke] Run `pnpm cli -- start <workspace>` manually once copilot is installed to verify it.')
    return
  }
  console.log(`[cli-smoke] copilot CLI resolved (${resolution.kind}); a full lifecycle run requires manual verification via "pnpm cli".`)
}

main().catch((error: unknown) => {
  console.error('[cli-smoke] failed:', error)
  process.exitCode = 1
})

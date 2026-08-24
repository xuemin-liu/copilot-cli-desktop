// Best-effort live smoke test. Unlike the sibling DeepSeek Harness Desktop
// project (which pins and installs its runtime as an npm dependency, so its
// smoke test always has a real binary to launch), the `copilot` CLI is an
// external tool this project does not/cannot vendor. When it is not
// installed, this script logs that and exits 0 rather than failing CI;
// when it IS installed (e.g. on a developer machine with `copilot` on PATH),
// it resolves the binary and spawns a real, very short-lived pty session to
// confirm the resolution + pty-spawn path actually works end to end.
import { resolveCopilotBinary } from '../src/main/resolve-copilot.js'
import { spawnNodePty } from '../src/main/node-pty-backend.js'
import { PtySession } from '../src/main/pty-session.js'

async function main(): Promise<void> {
  console.log('[smoke] Resolving the copilot CLI...')
  const resolution = await resolveCopilotBinary()
  if (resolution.version === null) {
    console.log('[smoke] copilot CLI not found; skipping the live smoke test.')
    console.log(resolution.error ?? '')
    return
  }
  console.log(`[smoke] Resolved ${resolution.kind} ${resolution.command} version ${resolution.version ?? 'unknown'}`)

  const session = new PtySession({
    file: resolution.command,
    // Launch the real interactive surface, rather than the very short-lived
    // `--version` command. On Windows ConPTY, an immediately exiting child can
    // race node-pty's console-list helper and produce a misleading
    // `AttachConsole failed` diagnostic even though spawning succeeded.
    args: [...resolution.prefixArgs],
    cwd: process.cwd(),
    spawnPty: spawnNodePty,
  })
  await session.start()
  await new Promise((resolve) => setTimeout(resolve, 2_000))
  await session.stop()
  console.log('[smoke] copilot pty session spawned and stopped cleanly.')
  console.log(session.recentOutput.join('\n'))
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    console.error('[smoke] failed:', error)
    process.exit(1)
  },
)

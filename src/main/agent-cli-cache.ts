import type { AgentCliResolution } from './agent-cli.js'
import type { OtherCli } from './session-cli.js'

/** How long a found CLI is kept for routine looks, such as the new-session dialog and the sidebar's version mark. */
export const OTHER_CLI_CACHE_MS = 60_000

/**
 * Other CLIs found on this computer, kept for a minute: finding one runs its `--version`. A miss is never kept, so a CLI
 * installed a moment ago is found by the next look. A fresh look, which every launch takes, skips the kept one and
 * replaces it, so a CLI updated in place is started, recorded and asked for its flags as the version that runs.
 */
export function createOtherCliCache(
  resolve: (cli: OtherCli) => Promise<AgentCliResolution>,
  now: () => number = Date.now,
): (cli: OtherCli, fresh?: boolean) => Promise<AgentCliResolution> {
  const known = new Map<OtherCli, { at: number; resolution: Promise<AgentCliResolution> }>()
  return (cli, fresh = false) => {
    const kept = known.get(cli)
    if (!fresh && kept && now() - kept.at < OTHER_CLI_CACHE_MS) return kept.resolution
    const resolution = resolve(cli)
    known.set(cli, { at: now(), resolution })
    void resolution.then((found) => found.version === null, () => true).then((missed) => {
      if (missed && known.get(cli)?.resolution === resolution) known.delete(cli)
    })
    return resolution
  }
}

/**
 * Every renderer surface in this app is a first-party, locally-loaded HTML
 * file — there is no embedded third-party web content (unlike the reference
 * project, which embeds a live web UI). These helpers still exist so IPC
 * handlers can assert the sender is exactly the expected local shell rather
 * than trusting `senderFrame` implicitly.
 */
export function isLauncherShellUrl(candidateUrl: string | null | undefined, shellUrl: string): boolean {
  if (!candidateUrl) return false
  try {
    const candidate = new URL(candidateUrl)
    const shell = new URL(shellUrl)
    return candidate.protocol === shell.protocol
      && candidate.pathname === shell.pathname
      && candidate.hash === shell.hash
  } catch {
    return false
  }
}

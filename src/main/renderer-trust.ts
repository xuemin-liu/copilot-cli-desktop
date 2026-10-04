/**
 * Only first-party, locally-loaded shell HTML may call desktop IPC. The
 * embedded debug browser has no preload bridge; its pages and frames must
 * never gain shell privileges.
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

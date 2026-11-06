/** A certificate Chromium refused for a page's main document, shown to the user as a warning. */
export interface CertificateFailure {
  /** Identifies this warning: an answer only applies to the warning the user was looking at. */
  id: number
  url: string
  host: string
  error: string
  issuer: string
  subject: string
  fingerprint: string
}

/** The host a certificate answers for, or null for anything that is not a TLS address. */
export function certificateHost(url: string): string | null {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' || parsed.protocol === 'wss:' ? parsed.hostname : null
  } catch { return null }
}

/** The errors a person can judge for themselves. Any other error, such as a revoked certificate, has no way past it. */
const OVERRIDABLE_ERRORS = new Set(['ERR_CERT_COMMON_NAME_INVALID', 'ERR_CERT_DATE_INVALID', 'ERR_CERT_AUTHORITY_INVALID'])

/** Whether the user may proceed past this error. */
export function certificateCanProceed(error: string): boolean {
  return OVERRIDABLE_ERRORS.has(error)
}

/** Why the certificate was refused, in words. */
export function certificateProblem(error: string, host: string): string {
  switch (error) {
    case 'ERR_CERT_COMMON_NAME_INVALID': return `The certificate is not valid for ${host}.`
    case 'ERR_CERT_DATE_INVALID': return 'The certificate has expired or is not valid yet. Check that this computer’s date is correct.'
    case 'ERR_CERT_AUTHORITY_INVALID': return 'The certificate was not issued by an authority this computer trusts.'
    case 'ERR_CERT_REVOKED': return `The certificate for ${host} has been revoked, so it should no longer be trusted.`
    default: return `The certificate for ${host} could not be verified.`
  }
}

/**
 * The certificates the user chose to proceed past, like Chrome's exceptions for one profile. An exception covers one
 * host, one certificate and one error, so a changed certificate or a new error warns again. Kept only until the app quits.
 */
export class CertificateExceptions {
  private readonly allowed = new Set<string>()
  private readonly hosts = new Set<string>()

  private key(host: string, error: string, fingerprint: string): string { return `${host}\n${error}\n${fingerprint}` }

  add(failure: Pick<CertificateFailure, 'host' | 'error' | 'fingerprint'>): void {
    if (!certificateCanProceed(failure.error)) return
    this.allowed.add(this.key(failure.host, failure.error, failure.fingerprint))
    this.hosts.add(failure.host)
  }

  allows(url: string, error: string, fingerprint: string): boolean {
    const host = certificateHost(url)
    return host !== null && Boolean(fingerprint) && this.allowed.has(this.key(host, error, fingerprint))
  }

  /** Whether the user proceeded past a warning for this address's host: its pages are shown as not secure. */
  coversHost(url: string): boolean {
    const host = certificateHost(url)
    return host !== null && this.hosts.has(host)
  }
}

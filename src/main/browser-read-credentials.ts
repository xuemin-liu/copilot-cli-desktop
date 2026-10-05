// Shared by text filtering and the fixed screenshot masker. The main process
// supplies this source to the isolated world; it never comes from HTTP callers.
export const CREDENTIAL_PATTERN_SOURCE = [
  String.raw`\b(?:proxy[- ]?)?authorization[ \t]*[:=][^\r\n]+`,
  String.raw`\b(?:Basic|Bearer)\s+[A-Za-z0-9.+/=_~-]+`,
  String.raw`\b(?:gh[pousr]_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]{16,}|glpat-[A-Za-z0-9_-]{16,}|xox[abprs]-[A-Za-z0-9-]{10,}|sk-[A-Za-z0-9_-]{16,}|(?:AKIA|ASIA)[0-9A-Z]{16})\b`,
  String.raw`\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b`,
  String.raw`-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)`,
].join('|')

// Reports whether this process, and what it starts, can reach the person's GitHub credentials. It prints only yes/no
// answers and lengths, never a secret. Phase 0 of docs/pr-loops-plan.md runs it inside and outside Copilot CLI's
// command sandbox. Usage: node pr-loop-credential-probe.mjs  (prints one JSON object)
import { spawnSync } from 'node:child_process'
import { appendFileSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const run = (file, args, input) => {
  const result = spawnSync(file, args, { input, encoding: 'utf8', timeout: 30_000, windowsHide: true,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1', GCM_INTERACTIVE: 'never' } })
  return { status: result.status, error: result.error ? result.error.code ?? 'error' : null, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}
const readable = path => { try { readFileSync(path); return true } catch { return false } }
const listable = path => { try { readdirSync(path); return true } catch { return false } }

const result = { platform: process.platform }
result.envTokens = ['GH_TOKEN', 'GITHUB_TOKEN', 'COPILOT_GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN']
  .filter(name => (process.env[name] ?? '').length > 0)
// A token in the environment may be real, or a sentinel a masking proxy swaps for the real one. Either way, what
// matters is whether GitHub accepts it from here, so ask GitHub (only the status code is kept).
result.envTokenAccepted = {}
for (const name of result.envTokens) {
  try {
    const response = await fetch('https://api.github.com/user', { headers: { authorization: `token ${process.env[name]}`, 'user-agent': 'pr-loop-probe' } })
    result.envTokenAccepted[name] = response.status === 200
  } catch (error) { result.envTokenAccepted[name] = `network ${error.cause?.code ?? error.name}` }
}

const status = run('gh', ['auth', 'status', '--hostname', 'github.com'])
result.ghAuthStatus = status.error ? `spawn ${status.error}` : status.status === 0 ? 'logged-in' : 'not-logged-in'
const token = run('gh', ['auth', 'token', '--hostname', 'github.com'])
result.ghTokenLength = token.status === 0 ? token.stdout.trim().length : 0
const user = run('gh', ['api', 'user', '--jq', '.id'])
result.ghApiUser = user.status === 0 && /^\d+$/.test(user.stdout.trim()) ? 'authenticated' : 'failed'
// A real token from a sandbox's masking proxy would still let a write through, so also ask GitHub who we are with the
// token itself, unmasked by any proxy, over plain node https. A fake (sentinel) token fails here.
if (token.status === 0 && token.stdout.trim()) {
  try {
    const response = await fetch('https://api.github.com/user', { headers: { authorization: `token ${token.stdout.trim()}`, 'user-agent': 'pr-loop-probe' } })
    result.tokenWorksDirectly = response.status === 200
  } catch (error) { result.tokenWorksDirectly = `network ${error.cause?.code ?? error.name}` }
}

const fill = run('git', ['credential', 'fill'], 'protocol=https\nhost=github.com\n\n')
const password = /^password=(.*)$/m.exec(fill.stdout)?.[1] ?? ''
result.gitCredentialLength = fill.status === 0 ? password.length : 0

const home = homedir(), appData = process.env.APPDATA ?? join(home, 'AppData', 'Roaming')
result.files = {
  ghHosts: readable(join(appData, 'GitHub CLI', 'hosts.yml')) || readable(join(home, '.config', 'gh', 'hosts.yml')),
  gitCredentials: readable(join(home, '.git-credentials')),
  sshDirectory: listable(join(home, '.ssh')),
  sshKey: ['id_ed25519', 'id_rsa', 'id_ecdsa'].some(name => readable(join(home, '.ssh', name))),
  copilotHome: listable(join(home, '.copilot')),
}
// The sandbox policy lives in the Copilot home's settings.json; a process that can write there could loosen it.
const policyHome = process.env.COPILOT_HOME
if (policyHome) {
  result.policyHomeReadable = readable(join(policyHome, 'settings.json'))
  try { appendFileSync(join(policyHome, 'probe-write.txt'), 'x'); result.policyHomeWritable = true; rmSync(join(policyHome, 'probe-write.txt'), { force: true }) }
  catch { result.policyHomeWritable = false }
}

if (process.platform === 'win32') {
  // Count Credential Manager entries that mention GitHub and whether one secret can be read (its length only).
  const script = `
$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public static class ProbeCred {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] public struct CREDENTIAL {
    public int Flags; public int Type; public string TargetName; public string Comment; public long LastWritten;
    public int CredentialBlobSize; public IntPtr CredentialBlob; public int Persist; public int AttributeCount;
    public IntPtr Attributes; public string TargetAlias; public string UserName; }
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool CredEnumerate(string filter, int flags, out int count, out IntPtr creds);
  [DllImport("advapi32.dll")] public static extern void CredFree(IntPtr buffer);
}
'@
$count=0; $ptr=[IntPtr]::Zero; $github=0; $readable=0
if ([ProbeCred]::CredEnumerate([NullString]::Value, 0, [ref]$count, [ref]$ptr)) {
  for ($i=0; $i -lt $count; $i++) {
    $item=[System.Runtime.InteropServices.Marshal]::ReadIntPtr($ptr, $i*[IntPtr]::Size)
    $cred=[System.Runtime.InteropServices.Marshal]::PtrToStructure($item, [type][ProbeCred+CREDENTIAL])
    if ($cred.TargetName -match 'github|gh:|copilot') { $github++; if ($cred.CredentialBlobSize -gt 0) { $readable++ } }
  }
  [ProbeCred]::CredFree($ptr)
  "enumerated=$count github=$github withSecret=$readable"
} else { "enumerate-failed=" + [System.Runtime.InteropServices.Marshal]::GetLastWin32Error() }`
  const cred = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script])
  result.credentialManager = (cred.stdout.trim() || cred.stderr.trim().split('\n')[0] || `exit ${cred.status}`).slice(0, 200)
}

try {
  const response = await fetch('https://api.github.com/zen', { headers: { 'user-agent': 'pr-loop-probe' } })
  result.outboundNetwork = response.status
} catch (error) { result.outboundNetwork = `failed ${error.cause?.code ?? error.name}` }

console.log('PROBE ' + JSON.stringify(result))

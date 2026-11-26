import { execFile } from 'node:child_process'
import { readdir, readFile, readlink } from 'node:fs/promises'
import { promisify } from 'node:util'
import { windowsSystemExecutable } from './resolve-copilot.js'

const run = promisify(execFile)

/** Identify the client end of an established IPv4 loopback connection among the supplied processes. */
export async function loopbackPeerPid(clientPort: number, serverPort: number, pids: readonly number[]): Promise<number | null> {
  if (pids.length === 0) return null
  const client = `127.0.0.1:${clientPort}`
  const server = `127.0.0.1:${serverPort}`
  try {
    if (process.platform === 'win32') {
      const { stdout } = await run(windowsSystemExecutable('netstat.exe'), ['-ano', '-p', 'tcp'], { windowsHide: true, timeout: 2_000 })
      for (const line of stdout.split(/\r?\n/)) {
        const [protocol, local, remote, , pid] = line.trim().split(/\s+/)
        if (protocol === 'TCP' && local === client && remote === server && pids.includes(Number(pid))) return Number(pid)
      }
    } else if (process.platform === 'darwin') {
      const { stdout } = await run('/usr/sbin/lsof', ['-nP', '-a', '-p', pids.join(','), `-iTCP@${server}`, '-sTCP:ESTABLISHED', '-Fpn'], { timeout: 2_000 })
      let pid = 0
      for (const line of stdout.split('\n')) {
        if (line.startsWith('p')) pid = Number(line.slice(1))
        if (line === `n${client}->${server}` && pids.includes(pid)) return pid
      }
    } else if (process.platform === 'linux') {
      const address = (port: number): string => `0100007F:${port.toString(16).toUpperCase().padStart(4, '0')}`
      const connections = await readFile('/proc/net/tcp', 'utf8')
      const clientAddress = address(clientPort)
      const serverAddress = address(serverPort)
      for (const line of connections.split('\n')) {
        const [, local, remote, state, , , , , , inode] = line.trim().split(/\s+/)
        if (local === clientAddress && remote === serverAddress && state === '01' && inode && inode !== '0') {
          const socket = `socket:[${inode}]`
          const owners = await Promise.all(pids.map(async (pid) => {
            const folder = `/proc/${pid}/fd`
            const names = await readdir(folder).catch(() => [])
            for (const name of names) {
              if (await readlink(`${folder}/${name}`).catch(() => null) === socket) return pid
            }
            return null
          }))
          const matches = owners.filter((pid) => pid !== null)
          return matches.length === 1 ? matches[0]! : null
        }
      }
    }
  } catch { /* Process and socket information may be unavailable on this machine. */ }
  return null
}

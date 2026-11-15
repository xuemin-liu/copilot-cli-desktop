import { createRequire } from 'node:module'
import { generateKeyPairSync } from 'node:crypto'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import net from 'node:net'
import { once } from 'node:events'
const require = createRequire(import.meta.url)
const Services = require('../vendor/myterminal/services.cjs')
const { Server, utils } = require('ssh2')
const { STATUS_CODE } = utils.sftp
export const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const key = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' })
export const listen = async server => { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return server.address().port }
export const until = async predicate => { for (let i = 0; i < 200; i++) { if (await predicate()) return; await delay(10) } throw new Error('Timed out') }

export async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'myterminal-services-'))
  const data = {}, files = new Map([['/sample.txt', Buffer.from('remote original')]])
  let savePath, openPaths, trusted = 0, available = true
  class Store {
    constructor() { this.path = join(directory, 'store.json') }
    get(key, fallback) { return structuredClone(data[key] ?? fallback) }
    set(key, value) { data[key] = structuredClone(value) }
    delete(key) { delete data[key] }
  }
  const electron = { dialog: {
    showMessageBox: async () => { trusted++; return { response: 1 } },
    showSaveDialog: async () => ({ canceled: !savePath, filePath: savePath }),
    showOpenDialog: async () => ({ canceled: !openPaths, filePaths: openPaths }),
  }, safeStorage: { isEncryptionAvailable: () => available, encryptString: value => Buffer.from('encrypted:' + value), decryptString: value => { const text = value.toString(); if (!text.startsWith('encrypted:')) throw new Error('bad cipher'); return text.slice(10) } } }
  const service = new Services(directory, () => null, { Store, electron })
  const clients = new Set(), shells = new Set(), forwards = new Set()
  const server = new Server({ hostKeys: [key] }, client => {
    clients.add(client); client.on('error', () => {}); client.on('close', () => clients.delete(client))
    client.on('authentication', ctx => ctx.username === 'tester' && ctx.password === 'secret' ? ctx.accept() : ctx.reject())
    client.on('ready', () => {
      client.on('session', accept => {
        const session = accept()
        session.on('pty', accept => accept?.())
        session.on('window-change', accept => accept?.())
        session.on('shell', accept => { const stream = accept(); shells.add(stream); stream.on('close', () => shells.delete(stream)); stream.on('error', () => {}); stream.write('SSH_READY\r\n'); stream.on('data', data => stream.write(data)) })
        session.on('exec', accept => { const stream = accept(); stream.end('pong\n') })
        session.on('sftp', accept => {
          const sftp = accept(), handles = new Map(); let count = 0
          let directoryRead = false
          const attrs = size => ({ mode: 0o100644, uid: 0, gid: 0, size, atime: 0, mtime: 0 })
          sftp.on('OPENDIR', id => { directoryRead = false; sftp.handle(id, Buffer.from('directory')) })
          sftp.on('READDIR', id => { if (directoryRead) { sftp.status(id, STATUS_CODE.EOF); return }; directoryRead = true; sftp.name(id, [...files].map(([name, data]) => ({ filename: name.slice(1), longname: name, attrs: attrs(data.length) }))) })
          sftp.on('REALPATH', (id, path) => sftp.name(id, [{ filename: path === '.' ? '/' : path, longname: path, attrs: attrs(0) }]))
          sftp.on('OPEN', (id, path, flags) => { if (!files.has(path) && !(flags & 8)) { sftp.status(id, STATUS_CODE.NO_SUCH_FILE); return }; if (flags & 16 || !files.has(path)) files.set(path, Buffer.alloc(0)); const handle = Buffer.from(String(++count)); handles.set(handle.toString(), path); sftp.handle(id, handle) })
          sftp.on('CLOSE', (id, handle) => { handles.delete(handle.toString()); sftp.status(id, STATUS_CODE.OK) })
          sftp.on('READ', (id, handle, offset, length) => { const value = files.get(handles.get(handle.toString())); if (!value || offset >= value.length) sftp.status(id, STATUS_CODE.EOF); else sftp.data(id, value.subarray(offset, offset + length)) })
          sftp.on('WRITE', (id, handle, offset, chunk) => { const name = handles.get(handle.toString()), before = files.get(name); const after = Buffer.alloc(Math.max(before.length, offset + chunk.length)); before.copy(after); chunk.copy(after, offset); files.set(name, after); sftp.status(id, STATUS_CODE.OK) })
          sftp.on('FSTAT', (id, handle) => sftp.attrs(id, attrs(files.get(handles.get(handle.toString())).length)))
          sftp.on('STAT', (id, path) => files.has(path) ? sftp.attrs(id, attrs(files.get(path).length)) : sftp.status(id, STATUS_CODE.NO_SUCH_FILE))
          sftp.on('RENAME', (id, from, to) => { files.set(to, files.get(from)); files.delete(from); sftp.status(id, STATUS_CODE.OK) })
          sftp.on('REMOVE', (id, path) => { files.delete(path); sftp.status(id, STATUS_CODE.OK) })
        })
      })
      client.on('tcpip', (accept, reject, info) => {
        const socket = net.connect(info.destPort, info.destIP)
        socket.on('error', () => { reject(); socket.destroy() })
        socket.once('connect', () => { const stream = accept(); stream.on('error', () => socket.destroy()); stream.pipe(socket).pipe(stream); stream.on('close', () => socket.destroy()) })
      })
      client.on('request', (accept, reject, name, info) => {
        if (name === 'tcpip-forward') {
          const forwarding = net.createServer(socket => client.forwardOut(info.bindAddr, info.bindPort, socket.remoteAddress, socket.remotePort, (error, stream) => {
            if (error) { socket.destroy(); return }; stream.on('error', () => socket.destroy()); socket.on('error', () => stream.destroy()); socket.pipe(stream).pipe(socket)
          }))
          forwards.add(forwarding); forwarding.on('error', reject); forwarding.listen(info.bindPort, info.bindAddr, () => accept(info.bindPort))
        } else if (name === 'cancel-tcpip-forward') { for (const forwarding of forwards) if (forwarding.address()?.port === info.bindPort) { forwarding.close(); forwards.delete(forwarding) }; accept?.() }
        else reject()
      })
    })
  })
  const port = await listen(server)
  const invoke = (method, ...args) => service.invoke(method, args, id => ['terminal', 'second', 'jump'].includes(id))
  await invoke('sessions:save', { id: 'saved', host: '127.0.0.1', port, username: 'tester', password: 'secret', authType: 'password' })
  return { directory, data, files, service, invoke, port, get trusted() { return trusted }, set available(value) { available = value }, set savePath(value) { savePath = value }, set openPaths(value) { openPaths = value },
    async close() { service.dispose(); for (const shell of shells) shell.destroy(); for (const client of clients) client.end(); for (const forwarding of forwards) forwarding.close(); await new Promise(resolve => server.close(resolve)) } }
}

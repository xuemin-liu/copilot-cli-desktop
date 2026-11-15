import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import net from 'node:net'
import { once } from 'node:events'
import { fixture, delay, listen, until } from './myterminal-ssh-fixture.mjs'

test('reused services encrypt/redact connections, merge backups, scope snippets and reject arbitrary operations', async () => {
  const f = await fixture()
  try {
    assert.ok(!JSON.stringify(f.data).includes('secret'))
    assert.equal((await f.invoke('sessions:getAll'))[0].hasPassword, true)
    assert.equal((await f.invoke('sessions:getAll'))[0].password, undefined)
    await f.invoke('snippets:save', { id: 'snippet', name: 'hello', command: 'echo hello' })
    await f.invoke('settings:set', { defaultFontSize: 18 })
    f.savePath = join(f.directory, 'backup.json'); await f.invoke('backup:export', { includeCredentials: false })
    const backup = JSON.parse(await readFile(join(f.directory, 'backup.json'), 'utf8'))
    assert.equal(backup.sessions[0].password, undefined)
    assert.equal(backup.snippets[0].command, 'echo hello')
    f.openPaths = [join(f.directory, 'backup.json')]
    assert.equal((await f.invoke('backup:import')).success, true)
    assert.equal((await f.invoke('settings:get')).defaultFontSize, 18)
    f.available = false
    await assert.rejects(f.invoke('sessions:save', { id: 'new', host: 'host', username: 'u', password: 'plaintext' }), /credential storage/)
    await assert.rejects(f.invoke('window:close'), /Unsupported/)
    await assert.rejects(f.invoke('sftp:readFile', 'foreign', '/sample.txt'), /belong/)
  } finally { await f.close() }
})

test('managed SSH reuses shells, host verification, SFTP editing/transfers, jump hosts and logging', async () => {
  const f = await fixture()
  try {
    const pty = await f.service.spawn('terminal', 'saved', new AbortController().signal)
    let output = ''; pty.onData(data => { output += data; f.service.output('terminal', data) })
    assert.equal(f.trusted, 1)
    await until(() => output.includes('SSH_READY'))
    const log = await f.invoke('logging:start', 'terminal', f.directory)
    pty.write('BACKGROUND_LOG\r\n'); await until(() => output.includes('BACKGROUND_LOG'))
    assert.ok((await f.invoke('ssh:ping', 'terminal')) >= 0)
    assert.equal(await f.invoke('sftp:readFile', 'terminal', '/sample.txt'), 'remote original')
    const unicode = '汉'.repeat(30000)
    f.files.set('/unicode.txt', Buffer.from(unicode, 'utf8'))
    const sftp = await f.service.ssh._getSftp('terminal'), createReadStream = sftp.createReadStream.bind(sftp)
    sftp.createReadStream = (path, options) => createReadStream(path, { ...options, highWaterMark: 32768 })
    const opened = await f.invoke('sftp:readFile', 'terminal', '/unicode.txt')
    assert.equal(opened.length, unicode.length, 'UTF-8 characters split across transfer chunks remain intact')
    assert.equal(opened, unicode)
    await f.invoke('sftp:writeFile', 'terminal', '/unicode.txt', opened)
    assert.equal(f.files.get('/unicode.txt').toString('utf8'), unicode)
    await f.invoke('sftp:writeFile', 'terminal', '/sample.txt', 'changed remotely')
    assert.equal(f.files.get('/sample.txt').toString(), 'changed remotely')
    const local = join(f.directory, 'download.txt')
    assert.match((await f.invoke('sftp:download', 'terminal', '/sample.txt', local)).error, /authoriz|access|permission/i)
    f.savePath = local; await f.invoke('dialog:saveFile', { securityScope: 'sftp-download' })
    await f.invoke('sftp:download', 'terminal', '/sample.txt', local)
    assert.equal(await readFile(local, 'utf8'), 'changed remotely')
    f.service.authorizeDrop([local]); await f.invoke('sftp:upload', 'terminal', local, '/uploaded.txt')
    assert.equal(f.files.get('/uploaded.txt').toString(), 'changed remotely')
    await f.invoke('logging:stop', 'terminal'); await until(async () => (await readFile(log.filePath, 'utf8')).includes('BACKGROUND_LOG'))
    const second = await f.service.spawn('second', 'saved', new AbortController().signal)
    assert.equal(f.trusted, 1, 'known fingerprint is reused')
    second.kill()
    const replacement = await f.service.spawn('second', 'saved', new AbortController().signal)
    let replacedOutput = '', prematureExit = false
    replacement.onData(data => { replacedOutput += data }); replacement.onExit(() => { prematureExit = true })
    replacement.write('RECONNECTED'); await until(() => replacedOutput.includes('RECONNECTED'))
    await delay(50); assert.equal(prematureExit, false, 'old connection close cannot end its replacement')
    replacement.kill()
    await f.invoke('sessions:save', { id: 'jumped', host: '127.0.0.1', port: f.port, username: 'tester', password: 'secret', jumpHost: '127.0.0.1', jumpPort: f.port, jumpUsername: 'tester', jumpPassword: 'secret' })
    const jumped = await f.service.spawn('jump', 'jumped', new AbortController().signal)
    let jumpOutput = ''; jumped.onData(data => { jumpOutput += data }); jumped.write('VIA_JUMP'); await until(() => jumpOutput.includes('VIA_JUMP')); jumped.kill()
    pty.kill(); assert.equal(f.service.ssh.connections.size, 0)
  } finally { await f.close() }
})

test('local, remote and fragmented SOCKS tunnels forward traffic and close their listeners', async () => {
  const f = await fixture(), echo = net.createServer(socket => { socket.on('error', () => {}); socket.pipe(socket) })
  const echoPort = await listen(echo)
  const sockets = []
  const unusedPort = async () => { const server = net.createServer(); const port = await listen(server); await new Promise(resolve => server.close(resolve)); return port }
  try {
    const pty = await f.service.spawn('terminal', 'saved', new AbortController().signal)
    for (const type of ['local', 'remote', 'dynamic']) {
      const port = await unusedPort()
      const config = type === 'local' ? { type, localPort: port, remoteHost: '127.0.0.1', remotePort: echoPort } : type === 'remote' ? { type, remotePort: port, localHost: '127.0.0.1', localPort: echoPort } : { type, localPort: port }
      const result = await f.invoke('tunnel:start', 'terminal', type, config); assert.ok(!result.error, result.error)
      const socket = net.connect(port, '127.0.0.1'); sockets.push(socket); await once(socket, 'connect')
      let received = Buffer.alloc(0); socket.on('data', data => { received = Buffer.concat([received, data]) })
      if (type === 'dynamic') {
        socket.write(Buffer.from([5])); await delay(5); socket.write(Buffer.from([1, 0])); await until(() => received.length === 2).catch(error => { throw new Error('SOCKS greeting received: ' + received.toString('hex') + ', destroyed=' + socket.destroyed, {cause:error}) }); received = Buffer.alloc(0)
        const frame = Buffer.from([5, 1, 0, 1, 127, 0, 0, 1, echoPort >> 8, echoPort & 255])
        socket.write(frame.subarray(0, 6)); await delay(5); socket.write(Buffer.concat([frame.subarray(6), Buffer.from('coalesced')])); await until(() => received.toString().includes('coalesced')); received = Buffer.alloc(0)
      }
      socket.write('TUNNEL_OK'); await until(() => received.toString().includes('TUNNEL_OK'))
      await f.invoke('tunnel:stop', type); socket.destroy()
      assert.equal(f.service.tunnels.tunnels.size, 0)
    }
    pty.kill()
  } finally { for (const socket of sockets) socket.destroy(); await f.close(); await new Promise(resolve => echo.close(resolve)) }
})

test('canceling pending SSH cannot leave a connection behind', async () => {
  const f = await fixture(), sockets = new Set(), stalled = net.createServer(socket => { sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket)) })
  const port = await listen(stalled)
  try {
    await f.invoke('sessions:save', { id: 'stalled', host: '127.0.0.1', port, username: 'tester' })
    const abort = new AbortController(), pending = f.service.spawn('terminal', 'stalled', abort.signal)
    await until(() => sockets.size > 0); abort.abort()
    await assert.rejects(pending, /cancel/i)
    assert.equal(f.service.ssh.pending.size, 0); assert.equal(f.service.ssh.connections.size, 0)
  } finally { for (const socket of sockets) socket.destroy(); stalled.close(); await f.close() }
})

test('recursive SFTP transfers cannot continue through a replacement connection', async () => {
  const f = await fixture()
  try {
    for (const direction of ['upload', 'download']) {
      const local = join(f.directory, direction); await mkdir(local); await writeFile(join(local, 'file.txt'), 'original connection only')
      let release, writes = 0
      const old = { sftp: { mkdir: (_path, callback) => { release = callback }, readdir: (_path, callback) => { release = () => callback(null, [{ filename: 'file.txt', attrs: { isDirectory: () => false, size: 24, mode: 0o100644 } }]) } } }
      f.service.ssh.connections.set('terminal', old)
      const pending = direction === 'upload' ? f.service.ssh.sftpUploadDir('terminal', local, '/destination') : f.service.ssh.sftpDownloadDir('terminal', '/source', local)
      await until(() => Boolean(release))
      f.service.ssh.connections.set('terminal', { sftp: {
        fastPut: (_from, _to, _options, callback) => { writes++; callback() },
        fastGet: (_from, _to, _options, callback) => { writes++; callback() },
      } })
      release()
      await assert.rejects(pending, /connection.*(changed|closed)/i)
      assert.equal(writes, 0, `${direction} must not access a replacement server`)
    }
  } finally { await f.close() }
})

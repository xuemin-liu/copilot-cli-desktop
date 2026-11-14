import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const {
  createLocalPathAuthorizer,
  createOneTimeTokenAuthorizer,
  isSafePathComponent,
  normalizeLocalSpawnOptions,
  normalizeRemoteBindAddress,
  resolveContainedChild,
} = require('../electron/security-utils')

describe('path containment helpers', () => {
  it('accepts simple remote filenames', () => {
    expect(isSafePathComponent('file.txt')).toBe(true)
    expect(isSafePathComponent('folder-name')).toBe(true)
  })

  it('rejects remote names that can escape local destinations', () => {
    for (const name of ['', '.', '..', '../x', '..\\x', '/tmp/x', 'C:\\tmp\\x', 'C:tmp', 'a/b', 'a\\b', 'nul\0x']) {
      expect(isSafePathComponent(name)).toBe(false)
    }
  })

  it('resolves children only under the selected parent', () => {
    const root = path.join(os.tmpdir(), 'myterminal-downloads')
    expect(resolveContainedChild(root, 'ok.txt')).toBe(path.resolve(root, 'ok.txt'))
    expect(() => resolveContainedChild(root, '..\\escape.txt')).toThrow()
  })
})

describe('local path authorization', () => {
  it('allows only authorized descendants for recursive grants', () => {
    let now = 1000
    const auth = createLocalPathAuthorizer({ now: () => now })
    const root = path.join(os.tmpdir(), 'myterminal-auth-root')
    auth.authorize(root, 'write', { recursive: true })

    expect(auth.canAccess(path.join(root, 'child.txt'), 'write')).toBe(true)
    expect(auth.canAccess(path.join(os.tmpdir(), 'outside.txt'), 'write')).toBe(false)

    now += 11 * 60 * 1000
    expect(auth.canAccess(path.join(root, 'child.txt'), 'write')).toBe(false)
  })
})

describe('one-time authorization tokens', () => {
  it('allows a token to be consumed only once', () => {
    let counter = 0
    const auth = createOneTimeTokenAuthorizer({
      randomBytes: () => Buffer.from(`token-${counter++}`),
    })
    const token = auth.issue()

    expect(auth.consume(token)).toBe(true)
    expect(auth.consume(token)).toBe(false)
  })

  it('rejects expired tokens', () => {
    let now = 1000
    const auth = createOneTimeTokenAuthorizer({
      now: () => now,
      randomBytes: () => Buffer.from('drop-token'),
      ttlMs: 500,
    })
    const token = auth.issue()

    now += 501

    expect(auth.consume(token)).toBe(false)
  })
})

describe('local terminal spawn normalization', () => {
  it('rejects renderer-selected executables and args', () => {
    expect(() => normalizeLocalSpawnOptions({ shell: 'cmd.exe' }, 'win32')).toThrow()
    expect(() => normalizeLocalSpawnOptions({ args: ['/c', 'calc'] }, 'win32')).toThrow()
  })

  it('allows default and validated WSL modes', () => {
    expect(normalizeLocalSpawnOptions({ mode: 'default' }, 'win32')).toMatchObject({ mode: 'default' })
    expect(normalizeLocalSpawnOptions({ mode: 'wsl', distro: 'Ubuntu' }, 'win32')).toMatchObject({
      mode: 'wsl',
      distro: 'Ubuntu',
    })
    expect(() => normalizeLocalSpawnOptions({ mode: 'wsl', distro: 'bad\nname' }, 'win32')).toThrow()
  })
})

describe('remote tunnel bind normalization', () => {
  it('defaults remote forwarding to loopback', () => {
    expect(normalizeRemoteBindAddress()).toBe('127.0.0.1')
    expect(normalizeRemoteBindAddress('localhost')).toBe('localhost')
  })

  it('rejects wildcard remote bind addresses', () => {
    expect(() => normalizeRemoteBindAddress('0.0.0.0')).toThrow()
    expect(() => normalizeRemoteBindAddress('::')).toThrow()
  })
})

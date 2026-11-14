const crypto = require('crypto')
const path = require('path')

const LOCAL_PATH_AUTH_TTL_MS = 10 * 60 * 1000
const DROP_PATH_AUTH_TTL_MS = 30 * 1000
const OSC52_MAX_BYTES = 1024 * 1024

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function normalizeForCompare(filePath) {
  const resolved = path.resolve(filePath)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function isPathInside(parent, child) {
  const normalizedParent = normalizeForCompare(parent)
  const normalizedChild = normalizeForCompare(child)
  const parentWithSep = normalizedParent.endsWith(path.sep)
    ? normalizedParent
    : normalizedParent + path.sep
  return normalizedChild === normalizedParent || normalizedChild.startsWith(parentWithSep)
}

function isSafePathComponent(name) {
  return typeof name === 'string' &&
    name.length > 0 &&
    name !== '.' &&
    name !== '..' &&
    !name.includes('\0') &&
    !name.includes('/') &&
    !name.includes('\\') &&
    !path.isAbsolute(name) &&
    !/^[a-zA-Z]:/.test(name)
}

function resolveContainedChild(parent, name) {
  if (!isSafePathComponent(name)) throw new Error(`Unsafe remote filename: ${name}`)
  const child = path.resolve(parent, name)
  if (!isPathInside(parent, child)) throw new Error(`Path escapes destination: ${name}`)
  return child
}

function createLocalPathAuthorizer({ now = () => Date.now() } = {}) {
  const grants = []

  const prune = () => {
    const cutoff = now()
    for (let i = grants.length - 1; i >= 0; i--) {
      if (grants[i].expiresAt <= cutoff) grants.splice(i, 1)
    }
  }

  const authorize = (filePath, access, { recursive = false } = {}) => {
    if (typeof filePath !== 'string' || !filePath) return
    if (!['read', 'write'].includes(access)) throw new Error(`Unknown path access: ${access}`)
    prune()
    grants.push({
      path: path.resolve(filePath),
      access,
      recursive: !!recursive,
      expiresAt: now() + LOCAL_PATH_AUTH_TTL_MS,
    })
  }

  const canAccess = (filePath, access) => {
    if (typeof filePath !== 'string' || !filePath) return false
    prune()
    return grants.some((grant) => {
      if (grant.access !== access) return false
      return grant.recursive
        ? isPathInside(grant.path, filePath)
        : normalizeForCompare(grant.path) === normalizeForCompare(filePath)
    })
  }

  const assertAccess = (filePath, access) => {
    if (!canAccess(filePath, access)) {
      throw new Error(`Local path was not authorized for ${access}`)
    }
  }

  return { authorize, canAccess, assertAccess, _grants: grants }
}

function createOneTimeTokenAuthorizer({
  now = () => Date.now(),
  randomBytes = (size) => crypto.randomBytes(size),
  ttlMs = DROP_PATH_AUTH_TTL_MS,
  maxTokens = 32,
} = {}) {
  const tokens = new Map()

  const prune = () => {
    const cutoff = now()
    for (const [token, expiresAt] of tokens) {
      if (expiresAt <= cutoff) tokens.delete(token)
    }
  }

  const issue = () => {
    prune()
    while (tokens.size >= maxTokens) {
      const oldestToken = tokens.keys().next().value
      if (!oldestToken) break
      tokens.delete(oldestToken)
    }
    const token = randomBytes(16).toString('hex')
    tokens.set(token, now() + ttlMs)
    return token
  }

  const consume = (token) => {
    if (typeof token !== 'string' || !token) return false
    prune()
    if (!tokens.has(token)) return false
    tokens.delete(token)
    return true
  }

  return { issue, consume, _tokens: tokens }
}

function normalizeLocalSpawnOptions(options = {}, platform = process.platform) {
  if (options == null) options = {}
  if (!isPlainObject(options)) throw new TypeError('local spawn options must be a plain object')
  if ('shell' in options || 'args' in options || 'cwd' in options) {
    throw new Error('Renderer-selected shell, args, and cwd are not allowed')
  }

  const mode = options.mode || 'default'
  const cols = Number.isInteger(options.cols) ? Math.min(Math.max(options.cols, 1), 1000) : 80
  const rows = Number.isInteger(options.rows) ? Math.min(Math.max(options.rows, 1), 500) : 24

  if (mode === 'default') {
    return { mode, cols, rows }
  }

  if (mode === 'wsl') {
    if (platform !== 'win32') throw new Error('WSL terminals are only available on Windows')
    const distro = options.distro
    if (distro != null && (typeof distro !== 'string' || !distro.trim() || /[\r\n\0]/.test(distro))) {
      throw new Error('Invalid WSL distro')
    }
    return { mode, distro: distro ? distro.trim() : '', cols, rows }
  }

  throw new Error(`Unknown local terminal mode: ${mode}`)
}

function normalizeRemoteBindAddress(value) {
  if (value == null || value === '') return '127.0.0.1'
  if (value === '127.0.0.1' || value === 'localhost' || value === '::1') return value
  throw new Error('Remote tunnel bind address must be loopback')
}

module.exports = {
  DROP_PATH_AUTH_TTL_MS,
  LOCAL_PATH_AUTH_TTL_MS,
  OSC52_MAX_BYTES,
  createLocalPathAuthorizer,
  createOneTimeTokenAuthorizer,
  isPathInside,
  isPlainObject,
  isSafePathComponent,
  normalizeLocalSpawnOptions,
  normalizeRemoteBindAddress,
  resolveContainedChild,
}

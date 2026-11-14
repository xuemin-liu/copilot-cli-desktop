import { describe, it, expect } from 'vitest'

// Replicate the validation helpers from main.js (they're not exported, so we test the logic)
function assertString(val, name) {
  if (typeof val !== 'string') throw new TypeError(`${name} must be a string, got ${typeof val}`)
}

function assertOptString(val, name) {
  if (val != null && typeof val !== 'string') throw new TypeError(`${name} must be a string or null, got ${typeof val}`)
}

function assertInt(val, name, { min = -Infinity, max = Infinity } = {}) {
  if (!Number.isInteger(val)) throw new TypeError(`${name} must be an integer, got ${typeof val}`)
  if (val < min || val > max) throw new RangeError(`${name} out of range [${min}, ${max}]: ${val}`)
}

function assertPlainObject(val, name) {
  if (!val || typeof val !== 'object' || Array.isArray(val)) throw new TypeError(`${name} must be a plain object`)
}

describe('assertString', () => {
  it('accepts strings', () => {
    expect(() => assertString('hello', 'test')).not.toThrow()
    expect(() => assertString('', 'test')).not.toThrow()
  })

  it('rejects non-strings', () => {
    expect(() => assertString(123, 'test')).toThrow(TypeError)
    expect(() => assertString(null, 'test')).toThrow(TypeError)
    expect(() => assertString(undefined, 'test')).toThrow(TypeError)
    expect(() => assertString({}, 'test')).toThrow(TypeError)
  })
})

describe('assertOptString', () => {
  it('accepts strings and null/undefined', () => {
    expect(() => assertOptString('hello', 'test')).not.toThrow()
    expect(() => assertOptString(null, 'test')).not.toThrow()
    expect(() => assertOptString(undefined, 'test')).not.toThrow()
  })

  it('rejects non-string non-null values', () => {
    expect(() => assertOptString(123, 'test')).toThrow(TypeError)
    expect(() => assertOptString({}, 'test')).toThrow(TypeError)
  })
})

describe('assertInt', () => {
  it('accepts integers', () => {
    expect(() => assertInt(42, 'test')).not.toThrow()
    expect(() => assertInt(0, 'test')).not.toThrow()
    expect(() => assertInt(-1, 'test')).not.toThrow()
  })

  it('rejects non-integers', () => {
    expect(() => assertInt(3.14, 'test')).toThrow(TypeError)
    expect(() => assertInt('5', 'test')).toThrow(TypeError)
    expect(() => assertInt(NaN, 'test')).toThrow(TypeError)
  })

  it('enforces min/max bounds', () => {
    expect(() => assertInt(5, 'test', { min: 1, max: 10 })).not.toThrow()
    expect(() => assertInt(0, 'test', { min: 1 })).toThrow(RangeError)
    expect(() => assertInt(100, 'test', { max: 50 })).toThrow(RangeError)
  })
})

describe('assertPlainObject', () => {
  it('accepts plain objects', () => {
    expect(() => assertPlainObject({}, 'test')).not.toThrow()
    expect(() => assertPlainObject({ a: 1 }, 'test')).not.toThrow()
  })

  it('rejects arrays, null, and primitives', () => {
    expect(() => assertPlainObject([], 'test')).toThrow(TypeError)
    expect(() => assertPlainObject(null, 'test')).toThrow(TypeError)
    expect(() => assertPlainObject('str', 'test')).toThrow(TypeError)
    expect(() => assertPlainObject(42, 'test')).toThrow(TypeError)
  })
})

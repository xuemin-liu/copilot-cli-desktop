import { describe, it, expect } from 'vitest'
import { parseFilter, matchesFilter, colorizeOutput, stripAnsi, FILTER_PRESETS } from '../src/utils/terminalUtils'

describe('FILTER_PRESETS', () => {
  it('has 4 presets with required fields', () => {
    expect(FILTER_PRESETS).toHaveLength(4)
    for (const p of FILTER_PRESETS) {
      expect(p).toHaveProperty('label')
      expect(p).toHaveProperty('color')
      expect(p).toHaveProperty('pattern')
    }
  })
})

describe('parseFilter', () => {
  it('returns null regexes for empty input', () => {
    const { includeRe, excludeRe, error } = parseFilter('', false)
    expect(includeRe).toBeNull()
    expect(excludeRe).toBeNull()
    expect(error).toBeNull()
  })

  it('parses a simple include term', () => {
    const { includeRe, excludeRe } = parseFilter('error', false)
    expect(includeRe).toBeInstanceOf(RegExp)
    expect(includeRe.test('an error occurred')).toBe(true)
    expect(includeRe.test('all good')).toBe(false)
    expect(excludeRe).toBeNull()
  })

  it('handles exclude terms with - prefix', () => {
    const { includeRe, excludeRe } = parseFilter('error|-debug', false)
    expect(includeRe.test('error')).toBe(true)
    expect(excludeRe.test('debug')).toBe(true)
  })

  it('handles exclude terms with ! prefix', () => {
    const { excludeRe } = parseFilter('!verbose', false)
    expect(excludeRe.test('verbose output')).toBe(true)
  })

  it('returns error for invalid regex', () => {
    const { error } = parseFilter('[invalid', true)
    expect(error).toBeTruthy()
  })

  it('escapes special chars in non-regex mode', () => {
    const { includeRe } = parseFilter('file.txt', false)
    expect(includeRe.test('file.txt')).toBe(true)
    expect(includeRe.test('fileatxt')).toBe(false)
  })

  it('keeps regex syntax in regex mode', () => {
    const { includeRe } = parseFilter('file.txt', true)
    expect(includeRe.test('fileatxt')).toBe(true) // . matches any char
  })
})

describe('matchesFilter', () => {
  it('returns false when no regexes provided', () => {
    expect(matchesFilter('anything', null, null)).toBe(false)
  })

  it('matches include pattern', () => {
    expect(matchesFilter('error here', /error/i, null)).toBe(true)
    expect(matchesFilter('no match', /error/i, null)).toBe(false)
  })

  it('excludes matching exclude pattern', () => {
    expect(matchesFilter('error debug', /error/i, /debug/i)).toBe(false)
    expect(matchesFilter('error only', /error/i, /debug/i)).toBe(true)
  })
})

describe('stripAnsi', () => {
  it('strips CSI sequences', () => {
    expect(stripAnsi('\x1b[31mred\x1b[0m')).toBe('red')
  })

  it('strips OSC sequences', () => {
    expect(stripAnsi('\x1b]0;title\x07text')).toBe('text')
  })

  it('strips ST-terminated OSC sequences', () => {
    expect(stripAnsi('\x1b]52;c;aGVsbG8=\x1b\\text')).toBe('text')
  })

  it('strips charset sequences', () => {
    expect(stripAnsi('\x1b(Btext')).toBe('text')
  })

  it('handles plain text unchanged', () => {
    expect(stripAnsi('hello world')).toBe('hello world')
  })
})

describe('colorizeOutput', () => {
  it('wraps error keywords in red ANSI', () => {
    const result = colorizeOutput('an error occurred')
    expect(result).toContain('\x1b[1;31m')
    expect(result).toContain('error')
  })

  it('wraps warning keywords in yellow ANSI', () => {
    const result = colorizeOutput('warning: deprecation')
    expect(result).toContain('\x1b[1;33m')
  })

  it('does not colorize inside existing ANSI sequences', () => {
    const result = colorizeOutput('\x1b[36merror\x1b[0m')
    // "error" is inside a cyan sequence, should not be double-wrapped
    expect(result).toBe('\x1b[36merror\x1b[0m')
  })

  it('handles plain text without keywords unchanged', () => {
    expect(colorizeOutput('hello world')).toBe('hello world')
  })
})

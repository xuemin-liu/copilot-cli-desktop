import { describe, expect, it, vi } from 'vitest'
import {
  decodeOsc52Payload,
  registerOsc52ClipboardHandler,
  updateOscSequenceState,
} from '../src/utils/terminalClipboardUtils'

describe('decodeOsc52Payload', () => {
  it('decodes clipboard-targeted OSC 52 payloads', () => {
    expect(decodeOsc52Payload('c;aGVsbG8gd29ybGQ=')).toBe('hello world')
  })

  it('accepts an empty target as the default clipboard target', () => {
    expect(decodeOsc52Payload(';Y29weSBtZQ==')).toBe('copy me')
  })

  it('ignores queries and non-clipboard targets', () => {
    expect(decodeOsc52Payload('c;?')).toBeNull()
    expect(decodeOsc52Payload('p;aGVsbG8=')).toBeNull()
  })

  it('returns null for invalid payloads', () => {
    expect(decodeOsc52Payload('c;not valid!')).toBeNull()
    expect(decodeOsc52Payload('missing-separator')).toBeNull()
  })
})

describe('registerOsc52ClipboardHandler', () => {
  function makeHandler() {
    let handler = null
    const term = {
      parser: {
        registerOscHandler: vi.fn((_ident, callback) => {
          handler = callback
          return { dispose: vi.fn() }
        }),
      },
    }
    return { term, get handler() { return handler } }
  }

  it('consumes OSC 52 without writing when disabled', () => {
    const fixture = makeHandler()
    const writeText = vi.fn()

    registerOsc52ClipboardHandler(fixture.term, writeText)

    expect(fixture.term.parser.registerOscHandler).toHaveBeenCalledWith(52, expect.any(Function))
    expect(fixture.handler('c;Y2xpcGJvYXJk')).toBe(true)
    expect(writeText).not.toHaveBeenCalled()
  })

  it('writes decoded text only when explicitly enabled', () => {
    const fixture = makeHandler()
    const writeText = vi.fn()

    registerOsc52ClipboardHandler(fixture.term, writeText, { enabled: true })

    expect(fixture.handler('c;Y2xpcGJvYXJk')).toBe(true)
    expect(writeText).toHaveBeenCalledWith('clipboard')
  })

  it('blocks oversized clipboard payloads', () => {
    const fixture = makeHandler()
    const writeText = vi.fn()

    registerOsc52ClipboardHandler(fixture.term, writeText, { enabled: true, maxBytes: 3 })

    expect(fixture.handler('c;dG9vIGxvbmc=')).toBe(true)
    expect(writeText).not.toHaveBeenCalled()
  })
})

describe('updateOscSequenceState', () => {
  it('tracks BEL-terminated OSC sequences across chunks', () => {
    const open = updateOscSequenceState(false, 'before\x1b]52;c;Y2xp')
    expect(open).toBe(true)

    const closed = updateOscSequenceState(open, 'cGJvYXJk\x07after')
    expect(closed).toBe(false)
  })

  it('tracks ST-terminated OSC sequences', () => {
    expect(updateOscSequenceState(false, '\x1b]52;c;YQ==\x1b\\')).toBe(false)
  })
})

import { describe, expect, it } from 'vitest'
import { appendOutputLines, updateCwdDetection } from '../src/utils/terminalSessionUtils'

describe('terminalSessionUtils', () => {
  it('buffers partial output lines and appends complete clean lines', () => {
    const lines = []
    let result = appendOutputLines(lines, '', 'first\r\nsec')

    expect(lines).toEqual(['first'])
    expect(result).toEqual({ pendingLine: 'sec', changed: true })

    result = appendOutputLines(lines, result.pendingLine, 'ond\n')

    expect(lines).toEqual(['first', 'second'])
    expect(result).toEqual({ pendingLine: '', changed: true })
  })

  it('detects OSC 7 cwd sequences split across chunks', () => {
    let state = updateCwdDetection('', '', '\x1b]7;file://host/home/de', '')
    expect(state.cwd).toBeNull()

    state = updateCwdDetection(state.rawBuffer, state.plainBuffer, 'v/project\x07', '')
    expect(state.cwd).toBe('/home/dev/project')
  })

  it('detects prompt cwd from a rolling plain-text buffer', () => {
    let state = updateCwdDetection('', '', '', 'root@host:/home/')
    expect(state.cwd).toBeNull()

    state = updateCwdDetection(state.rawBuffer, state.plainBuffer, '', 'dev/project# ')
    expect(state.cwd).toBe('/home/dev/project')
  })
})

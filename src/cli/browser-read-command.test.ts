import assert from 'node:assert/strict'
import test from 'node:test'
import { browserReadMethod, validateBrowserReadCommand } from './browser-read-command.js'

test('read command arguments cannot inject expressions, selectors, routes or an approval flag', () => {
  for (const [command, args] of [
    ['snapshot', ['1', 'frame', 'document.cookie']], ['snapshot', ['1', 'frame', '20001']], ['frames', ['0']], ['response', ['../cookies']],
    ['activate', ['1', 'frame', 'a'.repeat(32), 'n1', 'approved']], ['scroll', ['1', 'frame', '2001']],
    ['scroll', ['1', 'frame', '1', 'a'.repeat(32)]], ['snapshot', ['1', 'frame;document.cookie']],
  ] as [string, string[]][]) assert.throws(() => validateBrowserReadCommand(command, args), /Usage/)
  validateBrowserReadCommand('activate', ['1', 'frame', 'a'.repeat(32), 'n1'])
  validateBrowserReadCommand('snapshot', [])
  assert.equal(browserReadMethod('activate'), 'POST')
  assert.equal(browserReadMethod('scroll'), 'POST')
  assert.equal(browserReadMethod('select'), 'POST')
  assert.equal(browserReadMethod('snapshot'), 'GET')
})

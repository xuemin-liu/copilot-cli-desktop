import assert from 'node:assert/strict'
import test from 'node:test'
import { buildPluginInstallArgs, buildRemoteMcpAddArgs, buildResourceMutationArgs, buildSkillInstallArgs } from './copilot-resources.js'

test('resource mutation commands use explicit kind flags', () => {
  assert.deepEqual(buildResourceMutationArgs('disable', 'mcp', 'github'), ['plugins', 'disable', 'github', '--mcp'])
  assert.deepEqual(buildResourceMutationArgs('remove', 'plugin', 'demo@market'), ['plugins', 'remove', 'demo@market'])
})

test('install commands preserve each argv value without a shell', () => {
  assert.deepEqual(buildPluginInstallArgs('owner/repo'), ['plugins', 'install', 'owner/repo'])
  assert.deepEqual(buildSkillInstallArgs('https://example.test/skill', true), [
    'plugins', 'install', '--skill', '--project', 'https://example.test/skill',
  ])
})

test('remote MCP configuration validates the URL protocol', () => {
  assert.deepEqual(buildRemoteMcpAddArgs('docs', 'https://example.test/mcp', 'http'), [
    'mcp', 'add', '--transport', 'http', 'docs', 'https://example.test/mcp',
  ])
  assert.throws(() => buildRemoteMcpAddArgs('bad', 'file:///tmp/mcp', 'sse'), /HTTP or HTTPS/)
})

test('resource values cannot be interpreted as extra CLI options', () => {
  assert.throws(() => buildPluginInstallArgs('--help'), /cannot start with a dash/)
  assert.throws(() => buildResourceMutationArgs('remove', 'plugin', '--all'), /cannot start with a dash/)
})

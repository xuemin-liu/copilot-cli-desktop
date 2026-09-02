import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeProviderConfig, providerEnvironment, validateProviderConfig } from './provider-config.js'

test('providerEnvironment configures an official custom-provider environment', () => {
  assert.deepEqual(providerEnvironment({
    type: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    model: 'claude-model',
    offline: true,
  }, {}), {
    COPILOT_PROVIDER_TYPE: 'anthropic',
    COPILOT_PROVIDER_BASE_URL: 'https://api.anthropic.com',
    COPILOT_MODEL: 'claude-model',
    COPILOT_OFFLINE: 'true',
  })
})

test('providerEnvironment preserves inherited overrides and GitHub defaults', () => {
  assert.deepEqual(providerEnvironment({ type: 'github', baseUrl: '', model: '', offline: false }, {}), {})
  assert.deepEqual(providerEnvironment({
    type: 'openai',
    baseUrl: 'http://localhost:11434',
    model: 'local-model',
    offline: false,
  }, { COPILOT_MODEL: 'inherited-model' }), {
    COPILOT_PROVIDER_TYPE: 'openai',
    COPILOT_PROVIDER_BASE_URL: 'http://localhost:11434',
  })
})

test('provider configuration validates required custom-provider fields', () => {
  assert.throws(() => validateProviderConfig({ type: 'azure', baseUrl: '', model: 'deployment', offline: false }), /base URL/i)
  assert.throws(() => validateProviderConfig({ type: 'azure', baseUrl: 'file:///tmp/model', model: 'deployment', offline: false }), /HTTP or HTTPS/i)
  assert.deepEqual(normalizeProviderConfig({ type: 'invalid', baseUrl: 4 }), {
    type: 'github', baseUrl: '', model: '', offline: false,
  })
})

test('legacy embedded provider credentials are removed during normalization', () => {
  const migrations: string[] = []
  const config = normalizeProviderConfig({
    type: 'openai', baseUrl: 'https://user:token@gateway.example/v1', model: 'model', offline: false,
  }, (message) => migrations.push(message))
  assert.equal(config.baseUrl, 'https://gateway.example/v1')
  assert.equal(migrations.length, 1)
  assert.doesNotMatch(migrations[0] ?? '', /user|token/)
  assert.doesNotThrow(() => validateProviderConfig(config))
})

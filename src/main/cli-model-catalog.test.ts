import assert from 'node:assert/strict'
import test from 'node:test'
import type { AgentCliResolution } from './agent-cli.js'
import { readCopilotModelCatalog, readOtherCliModelCatalog } from './cli-model-catalog.js'
import type { OtherCli } from './session-cli.js'
import type { CopilotResolution } from './types.js'

function cliFixture(cli: OtherCli, script: string): AgentCliResolution {
  return { cli, command: process.execPath, prefixArgs: ['-e', script, '--'], resolvedPath: process.execPath, version: '1.0.0', error: null }
}

test('Copilot lists enabled models and Auto, while a custom provider can supply its model without spawning', async () => {
  const resolution: CopilotResolution = {
    kind: 'direct', command: process.execPath, resolvedPath: process.execPath, version: '1.0.0', error: null,
    prefixArgs: ['-e', String.raw`
      let input = ''
      process.stdin.on('data', (chunk) => {
        input += chunk
        const [header, body] = input.split('\r\n\r\n')
        if (!body || Buffer.byteLength(body) < Number(header.slice('Content-Length: '.length))) return
        const request = JSON.parse(body)
        if (request.method !== 'models.list') process.exit(1)
        const result = {
          auto: { tiers: [{type: 'auto', status: {enabled: true}}] },
          models: [
            {id: 'allowed', name: 'Allowed model', supportedReasoningEfforts: ['high', 'unknown']},
            {id: 'blocked', policy: {state: 'disabled'}},
            {id: '--flag'},
            {id: 'line\nbreak'},
          ],
        }
        const response = JSON.stringify({jsonrpc:'2.0', id:request.id, result})
        process.stdout.write('Content-Length: ' + Buffer.byteLength(response) + '\r\n\r\n' + response)
      })
    `, '--'],
  }
  assert.deepEqual(await readCopilotModelCatalog(resolution, {}), [
    { id: 'auto', label: 'Auto', efforts: [] },
    { id: 'allowed', label: 'Allowed model', efforts: ['high'] },
  ])
  assert.deepEqual(await readCopilotModelCatalog({ ...resolution, command: 'unused-copilot' }, {
    COPILOT_PROVIDER_TYPE: 'azure', COPILOT_MODEL: 'our-deployment',
  }), [{ id: 'our-deployment', label: 'our-deployment' }])
})

test('Claude returns model effort choices in the initialize response', async () => {
  const resolution = cliFixture('claude', String.raw`
    require('node:readline').createInterface({input: process.stdin}).on('line', (line) => {
      const request = JSON.parse(line)
      if (request.request?.subtype !== 'initialize') process.exit(1)
      console.log(JSON.stringify({type: 'system', subtype: 'init'}))
      console.log(JSON.stringify({ type: 'control_response', response: {
        request_id: request.request_id, subtype: 'success', response: { models: [
          {value: 'default', displayName: 'Default'},
          {value: 'sonnet', displayName: 'Sonnet', supportedEffortLevels: ['medium', 'max']},
          {value: 'haiku', displayName: 'Haiku'},
        ] },
      } }))
    })
  `)
  assert.deepEqual(await readOtherCliModelCatalog(resolution), [
    { id: 'sonnet', label: 'Sonnet', efforts: ['medium', 'max'] },
    { id: 'haiku', label: 'Haiku', efforts: [] },
  ])
})

test('Codex follows the model cursor and stops on a repeated cursor', async () => {
  const resolution = cliFixture('codex', String.raw`
    let initialized = false
    let pages = 0
    require('node:readline').createInterface({input: process.stdin}).on('line', (line) => {
      const request = JSON.parse(line)
      if (request.method === 'initialize') return console.log(JSON.stringify({id:request.id,result:{}}))
      if (request.method === 'initialized') { initialized = true; return }
      if (!initialized || request.method !== 'model/list' || ++pages > 2) process.exit(1)
      if ((pages === 1 && request.params.cursor !== undefined) || (pages === 2 && request.params.cursor !== 'page-two')) process.exit(1)
      const model = 'model-' + pages
      console.log(JSON.stringify({id:request.id,result:{
        nextCursor:'page-two',data:[
          {id:'internal-' + pages, model, displayName:model, supportedReasoningEfforts:[{reasoningEffort:'high'}]},
          {id:'hidden', hidden:true},
        ],
      }}))
    })
  `)
  assert.deepEqual(await readOtherCliModelCatalog(resolution), [
    { id: 'model-1', label: 'model-1', efforts: ['high'] },
    { id: 'model-2', label: 'model-2', efforts: ['high'] },
  ])
})

test('Antigravity accepts model rows with thinking variants and ignores command status text', async () => {
  const resolution = cliFixture('antigravity', String.raw`
    if (process.argv[1] !== 'models') process.exit(1)
    console.log('Fetching available models...')
    console.log('gemini-high\tGemini (High)')
    console.log('gemini-low  Gemini (Low)')
    console.log('--flag\tInvalid option')
  `)
  assert.deepEqual(await readOtherCliModelCatalog(resolution), [
    { id: 'gemini-high', label: 'Gemini (High)', efforts: [] },
    { id: 'gemini-low', label: 'Gemini (Low)', efforts: [] },
  ])
})

test('a JSON-line catalog probe rejects EOF and oversized output', async () => {
  await assert.rejects(readOtherCliModelCatalog(cliFixture('claude', 'process.exit(0)')), /catalog response ended/)
  await assert.rejects(readOtherCliModelCatalog(cliFixture('codex', 'process.stdout.write("x".repeat(8 * 1024 * 1024 + 1))')), /catalog response ended/)
})

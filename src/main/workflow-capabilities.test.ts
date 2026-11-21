import assert from 'node:assert/strict'
import test from 'node:test'
import { isWorkflowCliVersion, supportsTaskReporting, WORKFLOW_CLI_VERSION, workflowCliVersionNotice } from './workflow-capabilities.js'

test('only the verified CLI version turns the workflow features on, and the match is exact', () => {
  assert.equal(isWorkflowCliVersion(WORKFLOW_CLI_VERSION), true)
  for (const other of ['1.0.104', '1.0.106', '1.0.114', '1.0.1050', `${WORKFLOW_CLI_VERSION}-beta`, '', null, undefined]) {
    assert.equal(isWorkflowCliVersion(other), false, String(other))
  }
  const session = { version: WORKFLOW_CLI_VERSION, sideChat: false, preset: 'default' as const }
  assert.equal(supportsTaskReporting(session), true)
  assert.equal(supportsTaskReporting({ ...session, version: '1.0.114' }), false)
  assert.equal(supportsTaskReporting({ ...session, sideChat: true }), false)
  assert.equal(supportsTaskReporting({ ...session, remote: true }), false)
  assert.equal(supportsTaskReporting({ ...session, preset: 'read-only' }), false)
  assert.equal(supportsTaskReporting({ ...session, preset: null }), false)
  assert.equal(supportsTaskReporting(undefined), false)
})

test('another installed version is explained by name, with what it turns off; the verified or an unknown one is not', () => {
  assert.equal(workflowCliVersionNotice(WORKFLOW_CLI_VERSION), null)
  assert.equal(workflowCliVersionNotice(null), null)
  assert.equal(workflowCliVersionNotice(undefined), null)
  const notice = workflowCliVersionNotice('1.0.114')!
  assert.ok(notice.includes(`Copilot CLI ${WORKFLOW_CLI_VERSION} only`))
  assert.ok(notice.includes('Version 1.0.114 is installed'))
  assert.ok(notice.includes('Task reports and automatic work'))
})

import assert from 'node:assert/strict'
import test from 'node:test'
import { automaticWorkVersionRefusal, isWorkflowCliVersion, supportsTaskReporting, WORKFLOW_CLI_VERSION, workflowCliVersionNotice } from './workflow-capabilities.js'

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
  assert.ok(notice.includes('automatic work is off and new sessions cannot report'))
  assert.ok(notice.endsWith('Task outcomes can still be set by hand.'))
  // A session still running the verified version keeps reporting, and the notice says so instead of denying it.
  const mixed = workflowCliVersionNotice('1.0.114', true)!
  assert.ok(mixed.endsWith(`Sessions still running ${WORKFLOW_CLI_VERSION} keep reporting.`))
  assert.ok(!mixed.includes('by hand'))
  assert.equal(workflowCliVersionNotice(WORKFLOW_CLI_VERSION, true), null)
  assert.equal(automaticWorkVersionRefusal(WORKFLOW_CLI_VERSION), null)
  assert.equal(automaticWorkVersionRefusal(null), null)
  assert.equal(automaticWorkVersionRefusal('1.0.114'), `Automatic work is verified with Copilot CLI ${WORKFLOW_CLI_VERSION} only, and version 1.0.114 is installed`)
})

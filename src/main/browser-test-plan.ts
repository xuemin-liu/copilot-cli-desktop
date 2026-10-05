import { parseSafeHttpUrl } from './external-targets.js'

export const MAX_TEST_BYTES = 128 * 1024
export const TEST_KEYS = ['Enter', 'Tab', 'Escape', 'Space', 'Backspace', 'Delete', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'] as const
export interface BrowserTestStep {
  action: 'navigate' | 'click' | 'doubleClick' | 'hover' | 'fill' | 'select' | 'press' | 'scroll' | 'waitFor' | 'assert' | 'screenshot'
  label: string
  selector?: string
  text?: string
  frame?: string
  url?: string
  value?: string
  key?: string
  pixels?: number
  condition?: 'visible' | 'hidden' | 'text' | 'count' | 'checked' | 'value' | 'imageLoaded' | 'canvasPainted' | 'url'
  expected?: string | number | boolean
  timeoutMs?: number
}
export interface BrowserTestPlan { description: string; expected: string; steps: BrowserTestStep[]; timeoutMs?: number }
export interface BrowserTestReport {
  origin?: string
  description: string; expected: string; pageId: number; status: 'passed' | 'failed' | 'cancelled'; startedAt: string; durationMs: number
  steps: { action: string; label: string; status: 'passed' | 'failed' | 'skipped'; durationMs: number; reason?: string }[]
  screenshots: { step: number; imageBase64?: string; redacted: boolean; path?: string }[]
}
export interface BrowserTestState {
  enabled: boolean; running: boolean; step: number; total: number; label: string; report: Omit<BrowserTestReport, 'screenshots'> | null
}

/** Only fixed actions and conditions, never arbitrary script or filesystem commands. */
export function validateBrowserTestPlan(value: unknown): BrowserTestPlan {
  const fail = (message: string): never => { throw new Error(`Invalid browser test: ${message}`) }
  const object = (v: unknown): Record<string, unknown> => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) fail('expected an object.')
    return v as Record<string, unknown>
  }
  const fields = (v: Record<string, unknown>, allowed: string[]): void => {
    if (Object.keys(v).some(key => !allowed.includes(key))) fail('unsupported field.')
  }
  const string = (v: unknown, max: number, empty = false): void => {
    if (typeof v !== 'string' || (!empty && !v.trim()) || v.length > max || v.includes('\0')) fail('missing or oversized text.')
  }
  const timeout = (v: unknown, max: number): void => {
    if (v !== undefined && (typeof v !== 'number' || !Number.isInteger(v) || v < 100 || v > max)) fail('timeout is out of range.')
  }
  const plan = object(value)
  fields(plan, ['description', 'expected', 'steps', 'timeoutMs'])
  string(plan.description, 4000); string(plan.expected, 4000); timeout(plan.timeoutMs, 300000)
  if (!Array.isArray(plan.steps) || plan.steps.length < 1 || plan.steps.length > 50) fail('use 1–50 steps.')
  let assertions = 0; let screenshots = 0
  for (const raw of plan.steps as unknown[]) {
    const step = object(raw)
    const extra: Record<string, string[]> = {
      navigate: ['url'], click: ['selector', 'text', 'frame'], doubleClick: ['selector', 'text', 'frame'], hover: ['selector', 'text', 'frame'],
      fill: ['selector', 'text', 'frame', 'value'], select: ['selector', 'text', 'frame', 'value'],
      press: ['selector', 'text', 'frame', 'key'], scroll: ['selector', 'text', 'frame', 'pixels'],
      waitFor: ['selector', 'text', 'frame', 'condition', 'expected', 'timeoutMs'],
      assert: ['selector', 'text', 'frame', 'condition', 'expected', 'timeoutMs'], screenshot: [],
    }
    if (typeof step.action !== 'string' || !extra[step.action]) fail('unsupported action.')
    fields(step, ['action', 'label', ...extra[String(step.action)]!]); string(step.label, 200)
    if (step.frame !== undefined && (typeof step.frame !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(step.frame))) fail('invalid frame ID.')
    if (step.selector !== undefined) string(step.selector, 512)
    if (step.text !== undefined) string(step.text, 2000)
    if (step.action === 'navigate') { string(step.url, 8192); parseSafeHttpUrl(step.url as string) }
    if (['click', 'doubleClick', 'hover', 'fill', 'select', 'press'].includes(String(step.action))) string(step.selector, 512)
    if (step.action === 'fill' || step.action === 'select') string(step.value, 8192, true)
    if (step.action === 'press' && !TEST_KEYS.includes(step.key as typeof TEST_KEYS[number])) fail('unsupported key.')
    if (step.action === 'scroll' && (typeof step.pixels !== 'number' || !Number.isInteger(step.pixels) || Math.abs(step.pixels) > 2000)) fail('scroll must be within 2000 pixels.')
    if (step.action === 'screenshot' && ++screenshots > 5) fail('use at most five screenshots.')
    if (step.action === 'waitFor' || step.action === 'assert') {
      if (!['visible', 'hidden', 'text', 'count', 'checked', 'value', 'imageLoaded', 'canvasPainted', 'url'].includes(String(step.condition))) fail('unsupported condition.')
      if (step.condition !== 'url') string(step.selector, 512)
      timeout(step.timeoutMs, 60000)
      if (['text', 'url', 'value'].includes(String(step.condition))) string(step.expected, 2000, step.condition === 'value')
      else if (step.condition === 'count') {
        if (typeof step.expected !== 'number' || !Number.isInteger(step.expected) || step.expected < 0 || step.expected > 10000) fail('invalid expected count.')
      } else if (step.condition === 'checked') { if (typeof step.expected !== 'boolean') fail('expected must be boolean.') }
      else if (step.expected !== undefined) fail('this condition takes no expected value.')
      if (step.action === 'assert') assertions++
    }
  }
  if (!assertions) fail('include at least one assertion of the expected result.')
  if (Buffer.byteLength(JSON.stringify(value)) > MAX_TEST_BYTES) fail('plan exceeds 128 KiB.')
  return structuredClone(value) as BrowserTestPlan
}

import { parseSafeHttpUrl } from './external-targets.js'

export const MAX_TEST_BYTES = 128 * 1024
/** A reference PNG for compareScreenshot, read by the helper's shell and sent with the plan. */
export const MAX_BASELINE_BYTES = 2 * 1024 * 1024
export const MAX_BASELINE_BASE64 = Math.ceil(MAX_BASELINE_BYTES / 3) * 4
/** Screenshots and comparisons together. Each comparison can keep two images: the capture and a diff. */
export const MAX_TEST_IMAGES = 5
/** The largest test request: the plan plus one reference image per allowed comparison. */
export const MAX_TEST_REQUEST_BYTES = MAX_TEST_BYTES + MAX_TEST_IMAGES * (MAX_BASELINE_BASE64 + 64)
/** How many image files a helper reserves for a plan: one per screenshot, two per comparison. */
export function reservedTestImages(steps: readonly { action?: unknown }[]): number {
  return steps.reduce((count, step) => count + (step.action === 'screenshot' ? 1 : step.action === 'compareScreenshot' ? 2 : 0), 0)
}
/** A reference image path names a local absolute .png file. The desktop never opens it: the helper's shell reads it. Paths
 * with a quote or backslash are refused off Windows, so the sh helper can find them in the plan text without a JSON parser. */
export function validateBaselinePath(path: unknown, platform: NodeJS.Platform = process.platform): void {
  const windows = platform === 'win32'
  if (typeof path !== 'string' || path.length > 4096 || !/\.png$/i.test(path) || /[\u0000-\u001f]/.test(path) || /^[\\/]{2}/.test(path)
    || (windows ? !/^[A-Za-z]:[\\/]/.test(path) || /[<>:"|?*]/.test(path.slice(2)) || /(^|[\\/])(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|[\\/]|$)/i.test(path)
      : !path.startsWith('/') || /["\\]/.test(path))) {
    throw new Error('Invalid browser test: baseline must be a local absolute .png path; network and device paths are not allowed.')
  }
}
export const TEST_KEYS = ['Enter', 'Tab', 'Escape', 'Space', 'Backspace', 'Delete', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'] as const
/** Single letters and digits, for application shortcuts. */
export const TEST_CHARACTER_KEY = /^[a-z0-9]$/
/** Chords the browser handles itself (close, new tab, find, reload, DevTools, zoom): a test must not trigger them. */
export const RESERVED_CHORDS = ['w', 't', 'f', 'g', 'r', 'i', '0'] as const
export interface TestRequestMatch { urlPattern: string; method: string }
export interface TestNetworkFailure extends TestRequestMatch {
  failure: 'transport' | 'http'; status?: number; maxRequests: number; durationMs: number
}
export interface BrowserTestCondition {
  selector?: string
  targetRef?: string
  text?: string
  frame?: string
  condition?: 'visible' | 'hidden' | 'enabled' | 'text' | 'count' | 'checked' | 'value' | 'numericValue' | 'attribute' | 'imageLoaded' | 'canvasPainted' | 'url' | 'requestComplete' | 'stable' | 'consoleMessage'
  /** consoleMessage: only messages of this level. */
  level?: ConsoleLevel
  attribute?: string
  expected?: string | number | boolean
  /** numericValue: allowed difference. stable: allowed bounds change in CSS pixels (default 0.5). */
  tolerance?: number
  /** stable: how long the bounds must stay unchanged, in milliseconds (default 500). */
  stableMs?: number
  request?: TestRequestMatch & { state: 'finished' | 'failed'; status?: number }
}
/** compareScreenshot: per-channel difference allowed for a pixel to match, and the share of pixels allowed to differ. */
export interface TestImageTolerance { channel?: number; maxDiffRatio?: number }
export interface BrowserTestStep extends BrowserTestCondition {
  action: 'navigate' | 'reload' | 'discover' | 'click' | 'doubleClick' | 'hover' | 'drag' | 'dragTo' | 'fill' | 'select' | 'press' | 'scroll' | 'wheel' | 'waitFor' | 'assert' | 'screenshot' | 'compareScreenshot'
  label: string
  inputSelector?: string
  inputRef?: string
  point?: { x: number; y: number }
  modifiers?: ('Alt' | 'Control' | 'Meta' | 'Shift')[]
  button?: 'left' | 'middle' | 'right'
  url?: string
  value?: string
  key?: string
  pixels?: number
  /** wheel: CSS-pixel delta per event, and how many events (default 1). */
  deltaX?: number
  deltaY?: number
  repeat?: number
  /** screenshot and compareScreenshot: crop to this CSS-pixel viewport region. */
  region?: { x: number; y: number; width: number; height: number }
  /** compareScreenshot: the reference PNG's local path, as named in the plan. */
  baseline?: string
  /** compareScreenshot: the reference PNG as base64, attached by the helper that read the file. */
  baselineImage?: string
  /** compareScreenshot: rectangles to leave out, in CSS pixels relative to the compared area. */
  ignore?: { x: number; y: number; width: number; height: number }[]
  imageTolerance?: TestImageTolerance
  /** press: "page" sends the key to whatever has focus, with no target element. */
  scope?: 'page'
  path?: { x: number; y: number }[]
  /** dragTo: the element that receives the drop, and an optional CSS-pixel point inside it (default: its visible center). */
  dropSelector?: string
  dropRef?: string
  dropText?: string
  dropPoint?: { x: number; y: number }
  durationMs?: number
  timeoutMs?: number
  /** All conditions must hold in the same polling pass. No user code is evaluated. */
  all?: BrowserTestCondition[]
  dialog?: { accept: boolean; message?: string }
}
export interface BrowserTestPlan {
  description: string; expected: string; steps: BrowserTestStep[]; timeoutMs?: number
  allowNetworkFailures?: boolean; networkFailures?: TestNetworkFailure[]
  /** Fail the step during which the test page logs a console error, unless it matches an ignore pattern. */
  failOnConsoleError?: boolean
  consoleErrorIgnore?: string[]
}
export const CONSOLE_LEVELS = ['debug', 'info', 'warning', 'error'] as const
export type ConsoleLevel = typeof CONSOLE_LEVELS[number]
/** Console messages logged by the test page during one step. */
export interface TestStepConsole {
  entries: { level: string; message: string; source: string; line: number; count?: number }[]
  total: number; truncated: boolean; complete: boolean
}
export type TestDelivery = 'not-attempted' | 'partial' | 'delivered' | 'uncertain'
export interface BrowserTestStepResult {
  id?: string; action: string; label: string; status: 'passed' | 'failed' | 'skipped'; durationMs: number
  outcome?: 'delivered' | 'assertion-passed' | 'assertion-failed' | 'observed' | 'skipped' | 'cancelled' | 'uncertain' | 'failed'
  delivery?: TestDelivery; reason?: string; detail?: string; data?: Record<string, unknown>
  console?: TestStepConsole
}
export interface BrowserTestReport {
  runId?: string; completed?: boolean; origin?: string; testingEnabled?: boolean
  description: string; expected: string; pageId: number; status: 'passed' | 'failed' | 'cancelled'; startedAt: string; durationMs: number
  steps: BrowserTestStepResult[]
  screenshots: { step: number; imageBase64?: string; redacted: boolean; path?: string; region?: { x: number; y: number; width: number; height: number }
    /** compareScreenshot evidence: the capture that was compared, or the image marking the pixels that differ. */
    kind?: 'capture' | 'diff' }[]
  evidence?: Record<string, unknown>
}
export interface BrowserTestState {
  /** Compatibility field: the current HTTP(S) page is visible and ready for a new test; no opt-in is required. */
  enabled: boolean; running: boolean; step: number; total: number; label: string; report: Omit<BrowserTestReport, 'screenshots'> | null
  runId?: string
  currentAction?: { id: string; action: string; delivery: TestDelivery } | null
  lastCompletedAction?: BrowserTestStepResult | null
  /** Live journal is separate so progress cannot resize the UI's last-test panel. */
  journal?: Omit<BrowserTestReport, 'screenshots'>
}

/** Anchored literal glob, not a regular expression. Only * has special meaning: it matches any run of characters. */
export function globMatches(pattern: string, text: string): boolean {
  const parts = pattern.split('*')
  if (parts.length === 1) return text === pattern
  const first = parts.shift()!, last = parts.pop()!
  if (!text.startsWith(first) || !text.endsWith(last)) return false
  let offset = first.length
  const end = text.length - last.length
  for (const part of parts) { const next = text.indexOf(part, offset); if (next < 0 || next + part.length > end) return false; offset = next + part.length }
  return offset <= end
}

/** Literal URL glob, not a regular expression. Only * has special meaning. */
export function testRequestMatches(rule: TestRequestMatch, url: string, method: string): boolean {
  return rule.method === method && globMatches(rule.urlPattern, url)
}

/** Closed shapes and bounded fixed actions, never arbitrary scripts, headers, bodies or replay. */
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
  const target = (v: Record<string, unknown>, required: boolean): void => {
    if (v.selector !== undefined) string(v.selector, 512)
    if (v.targetRef !== undefined && (typeof v.targetRef !== 'string' || !/^[a-f0-9]{32}-t\d{1,3}$/.test(v.targetRef))) fail('invalid target reference.')
    if (v.selector !== undefined && v.targetRef !== undefined || required && v.selector === undefined && v.targetRef === undefined) fail('use exactly one selector or targetRef.')
    if (v.frame !== undefined && (typeof v.frame !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(v.frame))) fail('invalid frame ID.')
    if (v.text !== undefined) string(v.text, 2000)
  }
  const requestMatch = (v: Record<string, unknown>): void => {
    string(v.urlPattern, 2048)
    const url = new URL(parseSafeHttpUrl(String(v.urlPattern).replaceAll('*', 'wildcard')))
    if (url.search || url.hash || String(v.urlPattern).split('://')[1]?.split('/')[0]?.includes('*')) fail('request patterns need a literal origin and no query or fragment.')
    if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].includes(String(v.method))) fail('unsupported request method.')
  }
  const conditionFields = ['selector', 'targetRef', 'text', 'frame', 'condition', 'attribute', 'expected', 'tolerance', 'stableMs', 'level', 'request']
  const condition = (v: Record<string, unknown>): void => {
    if (!['visible', 'hidden', 'enabled', 'text', 'count', 'checked', 'value', 'numericValue', 'attribute', 'imageLoaded', 'canvasPainted', 'url', 'requestComplete', 'stable', 'consoleMessage'].includes(String(v.condition))) fail('unsupported condition.')
    const pageWide = ['url', 'requestComplete', 'consoleMessage'].includes(String(v.condition))
    target(v, !pageWide)
    if (pageWide && [v.selector, v.targetRef, v.text, v.frame].some(x => x !== undefined)) fail('this condition takes no target.')
    if (v.level !== undefined && (v.condition !== 'consoleMessage' || !CONSOLE_LEVELS.includes(v.level as ConsoleLevel))) fail('level requires the consoleMessage condition and one of debug, info, warning, error.')
    if (v.condition === 'requestComplete') {
      const request = object(v.request); fields(request, ['urlPattern', 'method', 'state', 'status']); requestMatch(request)
      if (!['finished', 'failed'].includes(String(request.state))) fail('request state must be finished or failed.')
      if (request.status !== undefined && (typeof request.status !== 'number' || !Number.isInteger(request.status) || request.status < 100 || request.status > 599)) fail('invalid request status.')
    } else if (v.request !== undefined) fail('request requires requestComplete.')
    if (v.condition === 'attribute') {
      if (typeof v.attribute !== 'string' || !/^(data-[a-z0-9][a-z0-9-]{0,63}|aria-[a-z-]{1,64}|role|title|class)$/.test(v.attribute)) fail('use a public data-*, aria-*, role, title or class attribute.')
    } else if (v.attribute !== undefined) fail('attribute requires the attribute condition.')
    if (v.tolerance !== undefined && (!['numericValue', 'stable'].includes(String(v.condition)) || typeof v.tolerance !== 'number' || !Number.isFinite(v.tolerance) || v.tolerance < 0
      || v.tolerance > (v.condition === 'stable' ? 50 : 1e12))) fail(v.condition === 'stable' ? 'stable tolerance must be within 0–50 CSS pixels.' : 'invalid numeric tolerance.')
    if (v.stableMs !== undefined && (v.condition !== 'stable' || typeof v.stableMs !== 'number' || !Number.isInteger(v.stableMs) || v.stableMs < 100 || v.stableMs > 5000)) fail('stableMs requires the stable condition and must be within 100–5000 milliseconds.')
    if (['text', 'url', 'value', 'attribute', 'consoleMessage'].includes(String(v.condition))) string(v.expected, 2000, ['value', 'attribute'].includes(String(v.condition)))
    else if (v.condition === 'numericValue') {
      if (typeof v.expected !== 'number' || !Number.isFinite(v.expected) || Math.abs(v.expected) > 1e12) fail('invalid expected number.')
    } else if (v.condition === 'count') {
      if (typeof v.expected !== 'number' || !Number.isInteger(v.expected) || v.expected < 0 || v.expected > 10000) fail('invalid expected count.')
    } else if (v.condition === 'checked') { if (typeof v.expected !== 'boolean') fail('expected must be boolean.') }
    else if (v.expected !== undefined) fail('this condition takes no expected value.')
  }
  const plan = object(structuredClone(value))
  fields(plan, ['description', 'expected', 'steps', 'timeoutMs', 'allowNetworkFailures', 'networkFailures', 'failOnConsoleError', 'consoleErrorIgnore'])
  if (plan.failOnConsoleError !== undefined && typeof plan.failOnConsoleError !== 'boolean') fail('failOnConsoleError must be boolean.')
  if (plan.consoleErrorIgnore !== undefined) {
    if (plan.failOnConsoleError !== true) fail('consoleErrorIgnore requires failOnConsoleError: true.')
    if (!Array.isArray(plan.consoleErrorIgnore) || plan.consoleErrorIgnore.length < 1 || plan.consoleErrorIgnore.length > 20) fail('use 1–20 console error ignore patterns.')
    for (const pattern of plan.consoleErrorIgnore as unknown[]) string(pattern, 500)
  }
  string(plan.description, 4000); string(plan.expected, 4000); timeout(plan.timeoutMs, 300000)
  if (plan.allowNetworkFailures !== undefined && typeof plan.allowNetworkFailures !== 'boolean') fail('allowNetworkFailures must be boolean.')
  if (plan.networkFailures !== undefined) {
    if (plan.allowNetworkFailures !== true) fail('network failure simulation requires explicit allowNetworkFailures: true.')
    if (!Array.isArray(plan.networkFailures) || plan.networkFailures.length < 1 || plan.networkFailures.length > 8) fail('use 1–8 failure rules.')
    for (const raw of plan.networkFailures as unknown[]) {
      const rule = object(raw); fields(rule, ['urlPattern', 'method', 'failure', 'status', 'maxRequests', 'durationMs']); requestMatch(rule)
      if (!['transport', 'http'].includes(String(rule.failure))) fail('unsupported network failure.')
      if (rule.failure === 'http' ? typeof rule.status !== 'number' || !Number.isInteger(rule.status) || rule.status < 400 || rule.status > 599 : rule.status !== undefined) fail('HTTP failures require status 400–599; transport failures take no status.')
      if (typeof rule.maxRequests !== 'number' || !Number.isInteger(rule.maxRequests) || rule.maxRequests < 1 || rule.maxRequests > 20) fail('failure rules require maxRequests within 1–20.')
      if (rule.durationMs === undefined) fail('failure rules require durationMs.')
      timeout(rule.durationMs, 60000)
    }
  }
  if (!Array.isArray(plan.steps) || plan.steps.length < 1 || plan.steps.length > 50) fail('use 1–50 steps.')
  let assertions = 0; let screenshots = 0
  for (const [index, raw] of (plan.steps as unknown[]).entries()) {
    const step = object(raw)
    const pointer = ['selector', 'targetRef', 'inputSelector', 'inputRef', 'point', 'text', 'frame', 'modifiers']
    const extra: Record<string, string[]> = {
      navigate: ['url', 'dialog'], reload: ['all', 'timeoutMs', 'dialog'], discover: ['frame'],
      click: [...pointer, 'button', 'dialog'], doubleClick: [...pointer, 'button', 'dialog'], hover: pointer,
      drag: [...pointer.filter(field => field !== 'point'), 'button', 'path', 'durationMs'],
      dragTo: ['selector', 'targetRef', 'text', 'frame', 'point', 'modifiers', 'dropSelector', 'dropRef', 'dropText', 'dropPoint', 'durationMs', 'dialog'],
      fill: ['selector', 'targetRef', 'text', 'frame', 'value', 'dialog'], select: ['selector', 'targetRef', 'text', 'frame', 'value', 'dialog'],
      press: ['selector', 'targetRef', 'text', 'frame', 'key', 'modifiers', 'dialog', 'scope'], scroll: ['selector', 'targetRef', 'text', 'frame', 'pixels'],
      wheel: [...pointer, 'deltaX', 'deltaY', 'repeat'],
      waitFor: [...conditionFields, 'all', 'timeoutMs'], assert: [...conditionFields, 'all', 'timeoutMs'], screenshot: ['region', 'selector', 'targetRef', 'text'],
      compareScreenshot: ['region', 'selector', 'targetRef', 'text', 'baseline', 'baselineImage', 'ignore', 'imageTolerance'],
    }
    if (typeof step.action !== 'string' || !extra[step.action]) fail('unsupported action.')
    fields(step, ['action', 'label', ...extra[String(step.action)]!])
    if (step.label === undefined) step.label = `${step.action} step ${index + 1}`
    string(step.label, 200)
    if (step.scope !== undefined) {
      if (step.action !== 'press' || step.scope !== 'page') fail('scope "page" is only for press.')
      if ([step.selector, step.targetRef, step.text, step.frame].some(x => x !== undefined)) fail('a page-level press takes no target, text or frame.')
    }
    target(step, ['click', 'doubleClick', 'hover', 'drag', 'dragTo', 'fill', 'select', 'wheel'].includes(String(step.action)) || step.action === 'press' && step.scope === undefined)
    if (step.inputSelector !== undefined) string(step.inputSelector, 512)
    if (step.inputRef !== undefined) target({ targetRef: step.inputRef }, true)
    if (step.inputSelector !== undefined && step.inputRef !== undefined) fail('use one inputSelector or inputRef.')
    const point = (raw: unknown): void => {
      const p = object(raw); fields(p, ['x', 'y'])
      if (![p.x, p.y].every(value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value < 20000)) fail('coordinates must be finite CSS pixels within 0–19999.')
    }
    if (step.point !== undefined) point(step.point)
    if (step.action !== 'drag' && (step.inputSelector !== undefined || step.inputRef !== undefined) && step.point === undefined) fail('pointer input surface requires a point.')
    if (step.modifiers !== undefined && (!Array.isArray(step.modifiers) || step.modifiers.length > 4 || new Set(step.modifiers).size !== step.modifiers.length || step.modifiers.some(m => !['Alt', 'Control', 'Meta', 'Shift'].includes(String(m))))) fail('invalid modifiers.')
    if (step.button !== undefined && !['left', 'middle', 'right'].includes(String(step.button))) fail('unsupported pointer button.')
    if (step.dialog !== undefined) {
      const dialog = object(step.dialog); fields(dialog, ['accept', 'message'])
      if (typeof dialog.accept !== 'boolean') fail('dialog.accept must be true or false.')
      if (dialog.message !== undefined) string(dialog.message, 500)
    }
    if (step.action === 'navigate') { string(step.url, 8192); parseSafeHttpUrl(step.url as string) }
    if (step.action === 'drag') {
      if (!Array.isArray(step.path) || step.path.length < 2 || step.path.length > 100) fail('drag requires 2–100 path points.')
      for (const rawPoint of step.path as unknown[]) point(rawPoint)
    }
    if (step.action === 'dragTo') {
      if (step.dropSelector !== undefined) string(step.dropSelector, 512)
      if (step.dropRef !== undefined && (typeof step.dropRef !== 'string' || !/^[a-f0-9]{32}-t\d{1,3}$/.test(step.dropRef))) fail('invalid drop target reference.')
      if ((step.dropSelector === undefined) === (step.dropRef === undefined)) fail('dragTo needs exactly one dropSelector or dropRef.')
      if (step.dropText !== undefined) string(step.dropText, 2000)
      if (step.dropPoint !== undefined) point(step.dropPoint)
    }
    if ((step.action === 'drag' || step.action === 'dragTo') && step.durationMs !== undefined && (typeof step.durationMs !== 'number' || !Number.isInteger(step.durationMs) || step.durationMs < 100 || step.durationMs > 5000)) fail('drag duration must be within 100–5000 milliseconds.')
    if (step.action === 'fill' || step.action === 'select') string(step.value, 8192, true)
    if (step.action === 'press') {
      if (typeof step.key !== 'string' || !TEST_KEYS.includes(step.key as typeof TEST_KEYS[number]) && !TEST_CHARACTER_KEY.test(step.key)) fail('unsupported key.')
      const modifiers = (step.modifiers ?? []) as string[]
      if ((modifiers.includes('Control') || modifiers.includes('Meta')) && RESERVED_CHORDS.includes(String(step.key) as typeof RESERVED_CHORDS[number])) fail('this chord is a browser shortcut (close, new tab, find, reload, DevTools or zoom); use the matching test action instead.')
    }
    if (step.action === 'wheel') {
      for (const delta of [step.deltaX, step.deltaY]) if (delta !== undefined && (typeof delta !== 'number' || !Number.isInteger(delta) || Math.abs(delta) > 1000)) fail('wheel deltas must be integers within ±1000 CSS pixels.')
      if (!step.deltaX && !step.deltaY) fail('wheel needs a nonzero deltaX or deltaY.')
      if (step.repeat !== undefined && (typeof step.repeat !== 'number' || !Number.isInteger(step.repeat) || step.repeat < 1 || step.repeat > 20)) fail('wheel repeat must be within 1–20 events.')
    }
    if (step.action === 'scroll' && (typeof step.pixels !== 'number' || !Number.isInteger(step.pixels) || Math.abs(step.pixels) > 2000)) fail('scroll must be within 2000 pixels.')
    if ((step.action === 'screenshot' || step.action === 'compareScreenshot') && ++screenshots > MAX_TEST_IMAGES) fail('use at most five screenshots and comparisons together.')
    if (step.action === 'compareScreenshot') {
      validateBaselinePath(step.baseline)
      if (step.baselineImage === undefined) fail('the reference image was not attached. Run the plan with the session browser helper, which reads the baseline file.')
      if (typeof step.baselineImage !== 'string' || !step.baselineImage || step.baselineImage.length > MAX_BASELINE_BASE64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(step.baselineImage)) fail('the reference image must be a PNG of at most 2 MiB.')
      if (step.ignore !== undefined) {
        if (!Array.isArray(step.ignore) || step.ignore.length < 1 || step.ignore.length > 20) fail('use 1–20 ignore rectangles.')
        for (const raw of step.ignore as unknown[]) {
          const rect = object(raw); fields(rect, ['x', 'y', 'width', 'height'])
          if (![rect.x, rect.y].every(value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value < 20000)
            || ![rect.width, rect.height].every(value => typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 20000)) fail('ignore rectangles need x and y within 0–19999 and width and height within 0–20000 CSS pixels.')
        }
      }
      if (step.imageTolerance !== undefined) {
        const tolerance = object(step.imageTolerance); fields(tolerance, ['channel', 'maxDiffRatio'])
        if (tolerance.channel !== undefined && (typeof tolerance.channel !== 'number' || !Number.isInteger(tolerance.channel) || tolerance.channel < 0 || tolerance.channel > 255)) fail('imageTolerance.channel must be an integer within 0–255.')
        if (tolerance.maxDiffRatio !== undefined && (typeof tolerance.maxDiffRatio !== 'number' || !Number.isFinite(tolerance.maxDiffRatio) || tolerance.maxDiffRatio < 0 || tolerance.maxDiffRatio > 1)) fail('imageTolerance.maxDiffRatio must be within 0–1.')
      }
      assertions++
    }
    if (step.region !== undefined) {
      const region = object(step.region); fields(region, ['x', 'y', 'width', 'height'])
      if (![region.x, region.y].every(value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value < 20000)
        || ![region.width, region.height].every(value => typeof value === 'number' && Number.isFinite(value) && value >= 1 && value <= 20000)) fail('region needs x and y within 0–19999 and width and height within 1–20000 CSS pixels.')
      if (step.selector !== undefined || step.targetRef !== undefined || step.text !== undefined) fail('crop to a region or to a target, not both.')
    }
    if ((step.action === 'screenshot' || step.action === 'compareScreenshot') && step.text !== undefined && step.selector === undefined && step.targetRef === undefined) fail('screenshot text filters a selector or targetRef.')
    if (['waitFor', 'assert', 'reload'].includes(String(step.action))) {
      timeout(step.timeoutMs, 60000)
      if (step.all !== undefined) {
        if (conditionFields.some(key => step[key] !== undefined)) fail('all cannot be combined with a single condition.')
        if (!Array.isArray(step.all) || step.all.length < 1 || step.all.length > 10) fail('use 1–10 readiness conditions.')
        for (const rawCondition of step.all as unknown[]) { const c = object(rawCondition); fields(c, conditionFields); condition(c) }
      } else if (step.action !== 'reload') condition(step)
      const stableWindow = Math.max(0, ...[step, ...(Array.isArray(step.all) ? step.all as Record<string, unknown>[] : [])]
        .filter(c => c.condition === 'stable').map(c => Number(c.stableMs ?? 500)))
      if (stableWindow && stableWindow >= Number(step.timeoutMs ?? (step.action === 'assert' ? 5000 : 30000))) fail('the stable window must be shorter than the step timeout.')
      if (step.action === 'assert') assertions++
    }
  }
  if (!assertions) fail('include at least one assertion of the expected result.')
  // Reference images are counted by their own limit, not the plan's.
  if (Buffer.byteLength(JSON.stringify(value, (key, field) => key === 'baselineImage' ? undefined : field)) > MAX_TEST_BYTES) fail('plan exceeds 128 KiB.')
  return plan as unknown as BrowserTestPlan
}

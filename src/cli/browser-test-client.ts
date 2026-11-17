import { open, readFile, stat, unlink } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { MAX_BASELINE_BYTES, MAX_TEST_BYTES, reservedTestImages, validateBaselinePath, validateBrowserTestPlan } from '../main/browser-test-plan.js'
import type { BrowserTestPlan, BrowserTestReport } from '../main/browser-test-plan.js'

export class BrowserTestRejectedError extends Error {
  constructor(message: string) { super(message); this.name = 'BrowserTestRejectedError' }
}

export function validateTestPath(path: string): void {
  if (!isAbsolute(path) || !/\.json$/i.test(path) || /^[\\/]{2}/.test(path) || /[\u0000-\u001f]/.test(path)
    || process.platform === 'win32' && (!/^[A-Za-z]:[\\/]/.test(path) || /[<>:"|?*]/.test(path.slice(2))
      || /(^|[\\/])(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|[\\/]|$)/i.test(path))) throw new Error('Test files must use local absolute .json paths.')
}

export async function loadBrowserTest(path: string, environment = process.env): Promise<BrowserTestPlan> {
  validateTestPath(path)
  if ((await stat(path)).size > MAX_TEST_BYTES) throw new Error('Test plan exceeds 128 KiB.')
  const text = await readFile(path, 'utf8')
  return parseBrowserTest(text, environment, await readBaselines(text))
}

/** The reference PNGs a plan's compareScreenshot steps name, read by the caller, keyed by the path as written. */
export async function readBaselines(text: string): Promise<Map<string, string>> {
  const images = new Map<string, string>()
  let raw: any
  try { raw = JSON.parse(text.replace(/^\uFEFF/, '')) } catch { return images }
  if (!Array.isArray(raw?.steps)) return images
  for (const step of raw.steps) {
    if (step?.action !== 'compareScreenshot' || typeof step.baseline !== 'string' || images.has(step.baseline)) continue
    validateBaselinePath(step.baseline)
    let size: number
    try { size = (await stat(step.baseline)).size } catch { throw new Error(`The baseline image does not exist: ${step.baseline}`) }
    if (size > MAX_BASELINE_BYTES) throw new Error('A baseline image exceeds 2 MiB.')
    images.set(step.baseline, (await readFile(step.baseline)).toString('base64'))
  }
  return images
}

/** A plan's text with its `valueFromEnv` inputs and its reference images filled in, validated. `baselines` holds the images
 * the caller read, keyed by the baseline path as the plan names it. */
export function parseBrowserTest(text: string, environment: Record<string, string | undefined>, baselines = new Map<string, string>()): BrowserTestPlan {
  let raw: any
  try { raw = JSON.parse(text.replace(/^\uFEFF/, '')) }
  catch { throw new Error('Invalid test JSON.') }
  if (Array.isArray(raw?.steps)) for (const step of raw.steps) {
    if (step && typeof step === 'object' && 'valueFromEnv' in step) {
      if (step.action !== 'fill' || 'value' in step || typeof step.valueFromEnv !== 'string' || !/^COPILOT_TEST_[A-Z0-9_]{1,115}$/.test(step.valueFromEnv)) throw new Error('valueFromEnv requires a fill step and a COPILOT_TEST_ environment variable name.')
      const value = environment[step.valueFromEnv]
      if (typeof value !== 'string') throw new Error('The test input environment variable is not set.')
      delete step.valueFromEnv; step.value = value
    }
    if (step && typeof step === 'object' && step.action === 'compareScreenshot') {
      if ('baselineImage' in step) throw new Error('Invalid browser test: baselineImage is attached by the helper; name the file in baseline.')
      const image = typeof step.baseline === 'string' ? baselines.get(step.baseline) : undefined
      if (image !== undefined) step.baselineImage = image
    }
  }
  return validateBrowserTestPlan(raw)
}

/**
 * The form fields the macOS and Linux helper sends: `plan` (the plan's text), `output` (the new report path), `env:NAME`
 * inputs, and for each reference image `baseline-N` (the file's bytes as base64) with `baselinePath-N` (its path as the
 * plan names it).
 */
export function parseTestForm(fields: Map<string, string>): { plan: BrowserTestPlan; output: string } {
  const text = fields.get('plan')
  const output = fields.get('output')
  if (text === undefined || output === undefined) throw new Error('Invalid test request.')
  if (Buffer.byteLength(text) > MAX_TEST_BYTES) throw new Error('Test plan exceeds 128 KiB.')
  const inputs: Record<string, string> = {}
  const baselines = new Map<string, string>()
  for (const [name, value] of fields) {
    if (name.startsWith('env:')) inputs[name.slice(4)] = value
    const index = /^baselinePath-(\d{1,2})$/.exec(name)?.[1]
    const image = index === undefined ? undefined : fields.get(`baseline-${index}`)
    if (image !== undefined) baselines.set(value, image)
  }
  return { plan: parseBrowserTest(text, inputs, baselines), output }
}

/** Reserve new artifacts before performing any page actions; never overwrite user files. */
export async function executeBrowserTest(plan: BrowserTestPlan, planPath: string, output: string | undefined,
  request: (plan: BrowserTestPlan) => Promise<unknown>): Promise<BrowserTestReport & { path: string }> {
  const path = output ?? planPath.replace(/\.json$/i, `.report-${randomUUID()}.json`)
  validateTestPath(path)
  const count = reservedTestImages(plan.steps)
  const paths = [path, ...Array.from({ length: count }, (_, index) => path.replace(/\.json$/i, `.image-${index + 1}.png`))]
  const files: Awaited<ReturnType<typeof open>>[] = []
  let performed = false
  try {
    for (const target of paths) files.push(await open(target, 'wx'))
    performed = true
    const report = await request(plan) as BrowserTestReport
    if (!report || !['passed', 'failed', 'cancelled'].includes(report.status) || !Array.isArray(report.steps) || !Array.isArray(report.screenshots) || report.screenshots.length > count) throw new Error('Invalid browser test response; do not rerun actions automatically.')
    for (const [index, image] of report.screenshots.entries()) {
      if (typeof image.imageBase64 !== 'string' || image.imageBase64.length > 3 * 1024 * 1024) throw new Error('Invalid test screenshot.')
      await files[index + 1]!.writeFile(Buffer.from(image.imageBase64, 'base64'))
      const region = image.region && ['x', 'y', 'width', 'height'].every(key => Number.isFinite((image.region as Record<string, unknown>)[key])) ? { region: image.region } : {}
      const kind = image.kind === 'capture' || image.kind === 'diff' ? { kind: image.kind } : {}
      const metadata = { step: image.step, redacted: image.redacted, path: paths[index + 1]!, ...region, ...kind }
      report.screenshots[index] = metadata
    }
    const saved = { ...report, path }
    await files[0]!.writeFile(JSON.stringify(saved, null, 2))
    for (let index = report.screenshots.length + 1; index < files.length; index++) { await files[index]!.close(); await unlink(paths[index]!) }
    return saved
  } catch (error) {
    if (error instanceof BrowserTestRejectedError) performed = false
    if (performed && files[0]) await files[0].writeFile(JSON.stringify({ status: 'unavailable', message: 'Test outcome unavailable. Inspect the browser last-test report before rerunning actions.' })).catch(() => {})
    else for (let index = 0; index < files.length; index++) { await files[index]!.close(); await unlink(paths[index]!).catch(() => {}) }
    throw error
  } finally { for (const file of files) await file.close().catch(() => {}) }
}

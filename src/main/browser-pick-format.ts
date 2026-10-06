import { sanitizedText, sanitizedUrl } from './browser-privacy.js'
import { redactBrowserValue } from './browser-read-privacy.js'

const MAX_PICK_TEXT = 2400

function field(value: unknown, max: number): string {
  return typeof value === 'string' ? sanitizedText(value).replace(/[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]+/g, ' ').trim().slice(0, max) : ''
}

/** Turns the isolated-world description of a clicked element into prompt text.
 * Every string is filtered again here, because the page controls what the script saw. */
export function formatPickedElement(raw: unknown): string {
  const value = redactBrowserValue(raw).value
  const info = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>
  const attributes = (info.attributes && typeof info.attributes === 'object' ? info.attributes : {}) as Record<string, unknown>
  const box = (info.box && typeof info.box === 'object' ? info.box : {}) as Record<string, unknown>
  const styles = (info.styles && typeof info.styles === 'object' ? info.styles : {}) as Record<string, unknown>
  const number = (item: unknown): number => typeof item === 'number' && Number.isFinite(item) ? Math.round(item) : 0
  const attributeText = Object.entries(attributes).flatMap(([name, item]) => {
    if (!/^[a-z][a-z-]{0,30}$/.test(name) || typeof item !== 'string') return []
    const safe = name === 'href' || name === 'src' ? sanitizedUrl(item).slice(0, 300) : field(item, 200)
    return [`${name}="${safe.replaceAll('"', "'")}"`]
  }).join(' ')
  const lines = [
    `[Browser element] <${field(info.label, 160) || field(info.tag, 40) || 'element'}> on ${sanitizedUrl(String(info.page ?? '')).slice(0, 300)}`,
    `Selector: ${field(info.selector, 400)}${info.unique ? '' : ' (not unique)'}`,
    ...(info.text ? [`Text: "${field(info.text, 300)}"`] : []),
    ...(attributeText ? [`Attributes: ${attributeText}`] : []),
    `Position: x=${number(box.x)} y=${number(box.y)} width=${number(box.width)} height=${number(box.height)}`,
    `Styles: ${['display', 'position', 'color', 'background', 'fontSize', 'fontWeight'].map(name => `${name}=${field(styles[name], 60)}`).join('; ')}`,
    ...(Array.isArray(info.path) && info.path.length ? [`Inside: ${info.path.map(item => field(item, 120)).filter(Boolean).join(' > ')}`] : []),
  ]
  return lines.join('\n').slice(0, MAX_PICK_TEXT)
}

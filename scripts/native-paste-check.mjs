// Real keyboard events -> production xterm/PTY -> CLI clipboard -> mock model.
// Run: npm run build && node scripts/electron-side-chat-check.mjs --native-paste
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app, BrowserWindow, clipboard, nativeImage } from 'electron'

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(action, label) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const result = await action()
    if (result) { console.log(`[native-paste] ${label}`); return result }
    await delay(100)
  }
  throw new Error(`Timed out: ${label}`)
}

export async function runNativePasteCheck() {
  await app.whenReady()
  const main = await until(() => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('/index.html')), 'main renderer')
  const ui = (window, code) => window.webContents.executeJavaScript(code)
  const state = () => ui(main, 'window.copilotDesktop.getState()')
  const artifacts = process.env.DESKTOP_UI_CHECK_ARTIFACTS
  const screenshot = async (window, name) => writeFile(join(artifacts, `${name}.png`), (await window.webContents.capturePage()).toPNG())
  const text = window => ui(window, `Array.from(document.querySelectorAll(':is(.session-pane-visible, .session-window) .xterm-rows > div'), row => row.textContent).join(${JSON.stringify('\n')})`)
  const imageNames = async window => (await text(window)).match(/copilot-image-[\w-]+\.png/g) ?? []
  const original = { text: clipboard.readText(), html: clipboard.readHTML(), rtf: clipboard.readRTF(), image: clipboard.readImage() }
  let ownedClipboard
  const ownClipboard = () => { ownedClipboard = { text: clipboard.readText(), image: clipboard.readImage().toPNG() } }
  const setText = value => { clipboard.writeText(value); ownClipboard() }
  const fixture = nativeImage.createFromBitmap(Buffer.alloc(32 * 32 * 4, 200), { width: 32, height: 32 })
  const setImage = () => { clipboard.writeImage(fixture); ownClipboard() }
  const key = async (window, keyCode, modifiers = []) => {
    await ui(window, `document.querySelector(':is(.session-pane-visible, .session-window) .xterm-helper-textarea').focus()`)
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers })
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers })
  }
  try {
    await writeFile(join(artifacts, 'result.json'), JSON.stringify({ passed: false }))
    const source = await until(async () => (await state()).tabs.find(t => t.status === 'running' && t.activity === 'idle'), 'source idle')
    const eventsPath = join(process.env.COPILOT_HOME, 'session-state', source.lastSessionId, 'events.jsonl')
    const events = async () => (await readFile(eventsPath, 'utf8')).trim().split('\n').map(JSON.parse)
    const users = async () => (await events()).filter(event => event.type === 'user.message')
    const replies = async () => (await events()).filter(event => event.type === 'assistant.message').length
    await until(async () => (await text(main)).includes('open sidebar'), 'input ready')
    main.show(); main.focus()
    const initialUsers = (await users()).length
    const initialReplies = await replies()
    const prompt = 'native-paste-text-42: explain this screenshot'
    setText(prompt)
    await key(main, 'V', ['control'])
    await until(async () => (await text(main)).includes('native-paste-text-42'), 'Ctrl+V text rendered')
    setImage()
    await key(main, 'V', ['control'])
    await until(async () => /Image|image|Attachment|attachment/.test(await text(main)), 'Ctrl+V image indicator')
    await screenshot(main, '01-image-draft')
    assert.ok((await text(main)).includes('native-paste-text-42'), 'Image paste must preserve the draft')
    assert.equal((await users()).length, initialUsers, 'Paste must not submit')
    await key(main, 'Enter')
    await until(async () => await replies() > initialReplies, 'image prompt completed')
    const first = (await users()).at(-1)
    await writeFile(join(artifacts, 'image-user-event.json'), JSON.stringify(first, null, 2))
    assert.ok(JSON.stringify(first).includes(prompt), 'Text must reach the CLI unchanged')
    assert.equal(first.data.content.split(prompt).length - 1, 1, 'Paste must not duplicate text')
    assert.equal(first.data.attachments.length, 1, 'Paste must attach exactly one image')
    const requests = JSON.parse(await readFile(join(artifacts, 'model-requests.json'), 'utf8'))
    assert.ok(JSON.stringify(requests.at(-1)).includes('data:image/'), 'Actual image bytes must reach the mock model')
    await screenshot(main, '02-image-sent')

    await ui(main, `window.copilotDesktop.popOutTab(${JSON.stringify(source.id)})`)
    const popout = await until(async () => {
      for (const window of BrowserWindow.getAllWindows()) {
        if (window === main || !window.webContents.getURL().endsWith('/index.html')) continue
        if ((await ui(window, 'window.copilotDesktop.getState()')).windowSessionId === source.id) return window
      }
    }, 'popout')
    await until(async () => (await text(popout)).includes('open sidebar'), 'popout ready')
    popout.show(); popout.focus()
    const multiline = 'native-paste-multiline-42\nsecond line with spaces and "quotes"'
    const beforeUsers = (await users()).length
    const beforeReplies = await replies()
    const previousImages = new Set(await imageNames(popout))
    setText(multiline)
    await key(popout, 'V', ['control'])
    await until(async () => (await text(popout)).includes('native-paste-multiline-42'), 'popout multiline text')
    setImage()
    await key(popout, 'V', ['alt'])
    await until(async () => (await imageNames(popout)).some(name => !previousImages.has(name)), 'Alt+V image indicator')
    await screenshot(popout, '03-popout-draft')
    assert.equal((await users()).length, beforeUsers, 'Multiline/image paste must not submit')
    await key(popout, 'Enter')
    await until(async () => await replies() > beforeReplies, 'popout image prompt completed')
    assert.ok(JSON.stringify((await users()).at(-1)).includes(JSON.stringify(multiline).slice(1, -1)), 'Multiline paste preserved')
    assert.equal((await users()).at(-1).data.attachments.length, 1, 'Alt+V must attach exactly one image')
    const finalRequests = JSON.parse(await readFile(join(artifacts, 'model-requests.json'), 'utf8'))
    const latestMessage = finalRequests.at(-1).messages.filter(message => message.role === 'user').at(-1)
    assert.ok(JSON.stringify(latestMessage).includes('data:image/'), 'Popout image must reach model')
    await writeFile(join(artifacts, 'result.json'), JSON.stringify({ passed: true, sourceSessionId: source.lastSessionId, cli: (await state()).resolution.version, checks: ['Ctrl+V text', 'Ctrl+V image bytes reach model', 'existing draft preserved', 'no automatic submit', 'popout multiline text', 'Alt+V image bytes reach model'] }, null, 2))
    console.log('[native-paste] PASS')
  } catch (error) {
    for (const [index, window] of BrowserWindow.getAllWindows().entries()) {
      await screenshot(window, `failure-${index}`).catch(() => {})
      await writeFile(join(artifacts, `failure-${index}.txt`), await text(window)).catch(() => {})
    }
    throw error
  } finally {
    if (ownedClipboard && clipboard.readText() === ownedClipboard.text && clipboard.readImage().toPNG().equals(ownedClipboard.image)) clipboard.write(original)
    app.quit()
  }
}

// File tabs in the real app: the built main process, preload, renderer and viewer script, driven through the window.
// Pass 1 opens files the way a terminal click does and checks every view; pass 2 starts the app again on the same data
// and checks that the tabs come back showing the right worktree's file.
// With --asar=<path to app.asar> the main process, renderer and viewer script are the packaged ones, read from inside the
// archive: this proves the viewer script that is loaded on first use is found in a packaged build, with no network.
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { mkdir, readFile, rename, rm, symlink, truncate, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { makePdf } from './pdf-fixture.mjs'

const out = resolve('test-results/file-viewer-app')
const delay = ms => new Promise(done => setTimeout(done, ms))
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR42mNk+M9Qz8DAwMDEAAUAGxEBgQ8XrCQAAAAASUVORK5CYII=', 'base64')

if (!process.versions.electron) {
  await mkdir(out, { recursive: true })
  const directory = join(out, `run-${Date.now()}`)
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  for (const pass of ['1', '2']) {
    const child = spawn((await import('electron')).default, [fileURLToPath(import.meta.url), ...process.argv.slice(2).filter(arg => arg.startsWith('--asar=')), directory, pass], { env, stdio: 'inherit', windowsHide: true })
    const timer = setTimeout(() => child.kill(), 240_000)
    try { assert.equal(await new Promise((done, reject) => { child.once('error', reject); child.once('exit', done) }), 0, `pass ${pass} failed`) }
    finally { clearTimeout(timer) }
  }
  console.log(`PASS: File tabs in the real app, across a restart${process.argv.some(arg => arg.startsWith('--asar=')) ? ' (packaged archive)' : ''}`)
} else {
  const { app, BrowserWindow, shell, clipboard } = await import('electron')
  const [directory, pass] = process.argv.slice(-2)
  const asar = process.argv.find(arg => arg.startsWith('--asar='))?.slice('--asar='.length)
  const built = path => asar ? pathToFileURL(join(resolve(asar), 'dist', 'src', 'main', path)).href : `../dist/src/main/${path}`
  app.setPath('userData', join(directory, 'userdata'))
  void run().catch(error => { console.error(error); app.exit(1) })

  async function run() {
    const workspace = join(directory, 'workspace'), worktree = join(directory, 'linked-worktree'), outside = join(directory, 'outside')
    process.env.COPILOT_HOME = join(directory, 'copilot-home')
    process.env.COPILOT_DISABLE_KEYTAR = '1'
    const revealed = []
    shell.showItemInFolder = path => { revealed.push(path) }
    const openedWithApp = []
    shell.openPath = async path => { openedWithApp.push(path); return '' }
    if (pass === '1') {
      await mkdir(join(directory, 'userdata'), { recursive: true })
      await mkdir(join(directory, 'copilot-home'), { recursive: true })
      await mkdir(join(workspace, 'src'), { recursive: true })
      await mkdir(join(workspace, 'docs', 'img'), { recursive: true })
      await mkdir(join(workspace, 'folder with spaces'))
      await mkdir(outside)
      execFileSync('git', ['init', '-q'], { cwd: workspace })
      await writeFile(join(workspace, 'src', 'app.ts'), ['// main version', 'export function answer(): number {', '  const value = 42', '  return value', '}', '/* a block', '   comment */', ''].join('\n'))
      await writeFile(join(workspace, 'folder with spaces', 'notes.txt'), 'plain notes\nsecond line\n')
      await writeFile(join(workspace, 'docs', 'img', 'dot.png'), PNG)
      await writeFile(join(workspace, 'docs', 'other.md'), '# Other page\n')
      await writeFile(join(workspace, 'docs', 'guide.md'), [
        '# Guide title', '', 'Some **bold** text and a [relative link](other.md) and a [web link](https://example.com/page).', '',
        '## Second part', '', '| Name | Count |', '| :--- | ---: |', '| apples | 3 |', '',
        '- [x] done item', '- [ ] open item', '', '```ts', 'const greeting: string = "hi"', '```', '',
        '![local dot](img/dot.png)', '', '![the same dot again](img/dot.png)', '', '![remote](https://example.com/tracker.png)', '', '![escape](../../outside/secret.png)', '',
        '<script>window.pwned = 1</script>', '<img src="x" onerror="window.pwned = 2">', '<a href="javascript:window.pwned=3">bad link</a>',
        '<iframe src="https://example.com"></iframe>', '<form action="https://example.com"><input name="q"><button>send</button></form>',
        '<div style="position:fixed;inset:0;background:red" class="app-shell file-panel-header">styled</div>', '<h2 id="root">clobber</h2>', '',
        '[jump](#second-part)', '',
      ].join('\n'))
      await writeFile(join(workspace, 'pixel.png'), PNG)
      await writeFile(join(workspace, 'tool.exe'), Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00]))
      await writeFile(join(workspace, 'archive.zip'), Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00]))
      await writeFile(join(outside, 'secret.txt'), 'outside secret\n')
      await writeFile(join(outside, 'secret.png'), PNG)
      await symlink(outside, join(workspace, 'escape'), 'junction')
      execFileSync('git', ['add', 'src', 'docs'], { cwd: workspace })
      execFileSync('git', ['-c', 'user.name=File fixture', '-c', 'user.email=file@example.invalid', 'commit', '-qm', 'Fixture'], { cwd: workspace })
      execFileSync('git', ['worktree', 'add', '--detach', worktree], { cwd: workspace })
      await writeFile(join(worktree, 'src', 'app.ts'), '// worktree version\nexport const where = "worktree"\n')
      const { createWorkspaceProfile, DEFAULT_DESKTOP_CONFIG, writeDesktopConfig } = await import(built('desktop-config.js'))
      const profile = createWorkspaceProfile(workspace)
      await writeDesktopConfig(join(directory, 'userdata', 'desktop.json'), { ...DEFAULT_DESKTOP_CONFIG, profiles: [profile], activeProfileId: profile.id,
        closeBehavior: 'quit', trayEnabled: false, notifications: false, automaticUpdateChecks: false })
    }
    await import(built('main.js'))
    await app.whenReady()
    let win
    for (let index = 0; index < 150 && !win; index++) { win = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('index.html')); if (!win) await delay(100) }
    assert.ok(win)
    win.setContentSize(1500, 900)
    const errors = []
    // While the sanitizer parses a file in a detached document, Chromium reports each inline handler it meets as blocked by
    // the page's policy. Nothing runs (window.pwned is checked below) and the handler is not in the output.
    const quiet = message => !/Autofill|DevTools|Executing inline event handler violates/.test(message)
    win.webContents.on('console-message', details => { if (details.level === 'error') errors.push(details.message) })
    const ui = code => win.webContents.executeJavaScript(code).catch(error => { throw new Error(`${error}\n${code}`) })
    const shot = async name => writeFile(join(out, name), (await win.webContents.capturePage()).toPNG())
    const until = async (code, label) => {
      const end = Date.now() + 20_000
      while (Date.now() < end) { if (await ui(`Boolean(${code})`)) return; await delay(30) }
      await shot(`failure-pass${pass}.png`)
      throw new Error(`Timed out: ${label}\n${await ui('document.body.innerText')}`)
    }
    const panel = '.tool-file-host:not([hidden])'
    const q = (selector, expression = 'element') => ui(`(() => { const element = document.querySelector(${JSON.stringify(`${panel} ${selector}`)}); return element ? ${expression} : null })()`)
    const click = label => ui(`[...document.querySelectorAll(${JSON.stringify(`${panel} button`)})].find(button => button.textContent === ${JSON.stringify(label)}).click()`)
    const buttons = () => ui(`[...document.querySelectorAll(${JSON.stringify(`${panel} .file-panel-actions button, ${panel} .file-card button`)})].map(button => button.textContent)`)
    const profileId = await ui('window.copilotDesktop.getState().then(state => state.activeProfileId)')
    const tools = async () => (await ui('window.copilotDesktop.toolsState()')).projects.find(project => project.profileId === profileId)
    const fileTabs = async () => (await tools()).tabs.filter(tab => tab.kind === 'file')
    const action = value => ui(`window.copilotDesktop.toolsAction(${JSON.stringify(profileId)}, ${JSON.stringify(value)})`)
    await until('document.querySelector(".session-pane")', 'initial session tab')

    if (pass === '2') {
      // --- After a restart: both tabs are back, each showing its own root's file. ---
      const tabs = await fileTabs()
      assert.deepEqual(tabs.map(tab => tab.file.path), ['src/app.ts', 'src/app.ts'], 'both files with the same relative path came back')
      const [main, linked] = tabs
      assert.notEqual(main.file.root, linked.file.root)
      await action({ type: 'select', id: main.id })
      await until(`document.querySelector(${JSON.stringify(`${panel} .file-code`)})?.textContent.includes('main version')`, 'restored main file')
      await action({ type: 'select', id: linked.id })
      await until(`document.querySelector(${JSON.stringify(`${panel} .file-code`)})?.textContent.includes('worktree version')`, 'restored worktree file')
      await shot('restored-worktree-tab.png')
      // The worktree goes away: the tab stays and says so; it is not dropped, and it does not fall back to the main file.
      execFileSync('git', ['worktree', 'remove', '--force', worktree], { cwd: workspace })
      await click('Reload')
      await until(`document.querySelector(${JSON.stringify(`${panel} .file-panel-status`)})?.textContent.includes('no longer')`, 'missing root state')
      assert.equal((await fileTabs()).length, 2, 'a tab whose root is gone is kept')
      assert.equal(await q('.file-code'), null)
      await click('Close tab')
      await until(`document.querySelectorAll('.tool-file-host').length === 1`, 'closed by its own button')
      assert.deepEqual(errors.filter(quiet), [])
      console.log('PASS 2: restored File tabs, missing root')
      app.exit(0)
      return
    }

    await ui('(async()=>{for(const tab of (await window.copilotDesktop.getState()).tabs) await window.copilotDesktop.unloadTab(tab.id)})()')
    const session = await ui('window.copilotDesktop.getState().then(state => state.activeTabId)')
    const open = (path, location, source = { tabId: session }) => ui(`window.copilotDesktop.openFile(${JSON.stringify(source)}, ${JSON.stringify(path)}, ${JSON.stringify(location ?? null)})`)

    // --- Nothing is loaded or shown before the first file. ---
    assert.equal(await ui('typeof window.copilotFileViewers'), 'undefined', 'no viewer code is loaded at start-up')
    assert.equal((await fileTabs()).length, 0)

    // --- A bare path with a location opens in a File tab, at that line. ---
    assert.deepEqual(await open('src/app.ts', { line: 3, column: 9 }), { ok: true })
    await until(`document.querySelector(${JSON.stringify(`${panel} .file-line-target`)})`, 'file tab at its line')
    assert.equal(await q('.file-line-target .file-ln', 'element.textContent'), '3')
    assert.match(await q('.file-line-target .file-lc', 'element.textContent'), /const value = 42/)
    await until(`document.querySelector(${JSON.stringify(`${panel} .file-code .hljs-keyword`)})`, 'syntax colors')
    assert.equal(await q('.file-code .hljs-keyword', 'getComputedStyle(element).color'), 'rgb(255, 123, 114)', 'keywords are colored')
    assert.equal(await q('.file-code .hljs-comment', 'getComputedStyle(element).color'), 'rgb(139, 148, 158)')
    assert.equal(await ui('typeof window.copilotFileViewers.text.markdown'), 'function', 'the viewer script loaded on first use')
    const viewerUrl = await ui(`document.querySelector('script[src*="viewer-text"]').src`)
    assert.match(viewerUrl, /^file:/, 'the viewer is a local file')
    if (asar) assert.ok(viewerUrl.includes('app.asar'), `the viewer came from the packaged archive: ${viewerUrl}`)
    assert.equal(await q('.file-code', 'element.querySelectorAll(".file-line").length'), 8)
    assert.equal(await q('.file-code', '[...element.querySelectorAll(".file-line")].every(line => line.querySelectorAll(":scope > span").length === 2)'), true, 'a block comment across lines keeps every line well-formed')
    assert.equal(await q('.file-code', '[...element.querySelectorAll(".file-line")][6].querySelector(".hljs-comment") !== null'), true)
    assert.ok((await ui('[...document.querySelectorAll(".tool-tab")].map(tab => tab.textContent.trim()).join("|")')).endsWith('app.ts'), 'the tab is named after the file')
    assert.equal((await tools()).visible, true)
    assert.deepEqual(revealed, [])
    await shot('code-view.png')

    // --- The same file again, at another line: one tab, moved. ---
    assert.deepEqual(await open('./src/app.ts', { line: 5 }), { ok: true })
    await until(`document.querySelector(${JSON.stringify(`${panel} .file-line-target .file-ln`)})?.textContent === '5'`, 'second click moves the line')
    assert.equal((await fileTabs()).length, 1)
    assert.deepEqual(await open(join(workspace, 'src', 'app.ts')), { ok: true }, 'an absolute path to the same file')
    assert.equal((await fileTabs()).length, 1)
    if (process.platform === 'win32') {
      // Windows does not tell names apart by case: another spelling is the same file, kept under its real name.
      assert.deepEqual(await open('SRC/APP.TS'), { ok: true })
      assert.deepEqual((await fileTabs()).map(tab => tab.file.path), ['src/app.ts'])
    }

    // --- Find in the file, across colored spans. ---
    await click('Find')
    await ui(`(() => { const input = document.querySelector(${JSON.stringify(`${panel} .file-find input`)}); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'const value'); input.dispatchEvent(new Event('input',{bubbles:true})) })()`)
    await until(`document.querySelector(${JSON.stringify(`${panel} .file-find [role=status]`)})?.textContent === '1 of 1'`, 'find result')
    assert.equal(await ui('CSS.highlights.get("file-find").size'), 1)
    await click('×')

    // --- A quoted path with spaces; a folder and Ctrl+click go to the file manager. ---
    assert.deepEqual(await open('folder with spaces/notes.txt'), { ok: true })
    await until(`document.querySelector(${JSON.stringify(`${panel} .file-code`)})?.textContent.includes('plain notes')`, 'path with spaces')
    assert.deepEqual(await open('folder with spaces'), { ok: true, revealed: true })
    assert.deepEqual(await open('src/app.ts', { reveal: true }), { ok: true, revealed: true })
    assert.deepEqual(await open(workspace), { ok: true, revealed: true }, 'the workspace folder itself is revealed')
    assert.deepEqual(revealed.splice(0), [join(workspace, 'folder with spaces'), join(workspace, 'src', 'app.ts'), workspace])
    assert.equal((await fileTabs()).length, 2)

    // --- Outside the workspace, through a link, or missing: refused quietly. ---
    assert.deepEqual(await open(join(outside, 'secret.txt')), { ok: false, reason: 'outside-workspace' })
    assert.deepEqual(await open('../outside/secret.txt'), { ok: false, reason: 'outside-workspace' })
    assert.deepEqual(await open('escape/secret.txt'), { ok: false, reason: 'outside-workspace' }, 'a link that leaves the workspace')
    assert.deepEqual(await open('src/missing.ts'), { ok: false, reason: 'missing' })
    assert.equal((await fileTabs()).length, 2)

    // --- Markdown: rendered, safe, with local pictures only. ---
    assert.deepEqual(await open('docs/guide.md'), { ok: true })
    await until(`document.querySelector(${JSON.stringify(`${panel} .file-markdown h1`)})`, 'rendered Markdown')
    await until(`document.querySelector(${JSON.stringify(`${panel} .file-markdown img[src^="data:image/png"]`)})`, 'local picture')
    await until(`document.querySelectorAll(${JSON.stringify(`${panel} .file-markdown .file-image-note`)}).length === 3`, 'remote, escaping and broken pictures replaced')
    const md = expression => q('.file-markdown', expression)
    assert.equal(await md('element.querySelector("h1").textContent'), 'Guide title')
    assert.equal(await md('element.querySelector("strong").textContent'), 'bold')
    assert.equal(await md('element.querySelectorAll("table td").length'), 2)
    assert.equal(await md('getComputedStyle(element.querySelector("td.file-align-right")).textAlign'), 'right')
    assert.equal(await md('element.querySelectorAll(".file-task").length'), 2)
    assert.equal(await md('element.querySelectorAll(".file-task-done").length'), 1)
    assert.equal(await md('element.querySelector("pre code .hljs-keyword") !== null'), true)
    await until(`document.querySelectorAll(${JSON.stringify(`${panel} .file-markdown img[src^="data:image/png"]`)}).length === 2`, 'a picture shown twice')
    assert.equal(await md('element.querySelectorAll("img").length'), 2, 'only the local picture, shown twice, is an image')
    assert.match(await md('[...element.querySelectorAll(".file-image-note")].map(note => note.textContent).join("|")'), /remote \(picture on the web, not loaded\)\|escape \(picture not found\)/)
    assert.equal(await md('element.querySelectorAll("script, iframe, form, input, button, style, [onerror], [style]").length'), 0)
    assert.equal(await md('[...element.querySelectorAll("a")].some(link => /javascript:/i.test(link.getAttribute("href") ?? ""))'), false)
    assert.equal(await ui('window.pwned'), undefined, 'no script from the file ran')
    assert.equal(await md('[...element.querySelectorAll("div")].find(div => div.textContent === "styled").className'), 'file-panel-header', 'only viewer classes survive')
    assert.equal(await md('getComputedStyle([...element.querySelectorAll("div")].find(div => div.textContent === "styled")).position'), 'static')
    assert.equal(await ui('document.getElementById("root").id'), 'root')
    assert.equal(await ui('document.getElementById("root").querySelector(".app-shell") !== null'), true, 'an id in the file cannot stand in for the app root')
    const requests = []
    win.webContents.session.webRequest.onBeforeRequest((details, done) => { if (/^https?:/.test(details.url)) requests.push(details.url); done({}) })
    await shot('markdown-view.png')

    // A heading anchor scrolls; a web link goes to the system browser; a relative link opens a File tab.
    await ui(`document.querySelector(${JSON.stringify(`${panel} .file-markdown a[href="#second-part"]`)}).click()`)
    const external = []
    shell.openExternal = async url => { external.push(url) }
    await ui(`document.querySelector(${JSON.stringify(`${panel} .file-markdown a[href="https://example.com/page"]`)}).click()`)
    for (let index = 0; index < 50 && !external.length; index++) await delay(20)
    assert.deepEqual(external, ['https://example.com/page'])
    assert.ok(win.webContents.getURL().endsWith('index.html'), 'the window did not navigate')
    await ui(`document.querySelector(${JSON.stringify(`${panel} .file-markdown a[href="other.md"]`)}).click()`)
    await until(`document.querySelector(${JSON.stringify(`${panel} .file-markdown h1`)})?.textContent === 'Other page'`, 'relative link opens its file')
    assert.equal((await fileTabs()).length, 4)
    assert.deepEqual(requests, [], 'no file content caused a network request')

    // Source view, and a click with a line shows the source at that line.
    const guide = (await fileTabs()).find(tab => tab.file.path === 'docs/guide.md')
    await action({ type: 'select', id: guide.id })
    await until(`document.querySelector(${JSON.stringify(`${panel} .file-markdown h1`)})?.textContent === 'Guide title'`, 'back on the guide')
    await click('Source')
    await until(`document.querySelector(${JSON.stringify(`${panel} .file-code`)})?.textContent.includes('# Guide title')`, 'Markdown source')
    await click('Rendered')
    await until(`document.querySelector(${JSON.stringify(`${panel} .file-markdown h1`)})`, 'rendered again')
    assert.deepEqual(await open('docs/guide.md', { line: 5 }), { ok: true })
    await until(`document.querySelector(${JSON.stringify(`${panel} .file-line-target .file-ln`)})?.textContent === '5'`, 'a line click shows the source')

    // --- Pictures, and files with no viewer. ---
    assert.deepEqual(await open('pixel.png'), { ok: true })
    await until(`document.querySelector(${JSON.stringify(`${panel} .file-image img`)})?.naturalWidth === 2`, 'picture')
    assert.ok((await buttons()).includes('Open with default app'))
    assert.deepEqual(await open('tool.exe'), { ok: true })
    await until(`document.querySelector(${JSON.stringify(`${panel} .file-card`)})`, 'card for a program')
    assert.deepEqual(await buttons(), ['Reload', 'Copy path', 'Reveal in folder', 'Reveal in folder'], 'a program is never offered Open with default app')
    const exe = (await fileTabs()).find(tab => tab.file.path === 'tool.exe')
    await assert.rejects(ui(`window.copilotDesktop.fileCommand(${JSON.stringify(profileId)}, ${JSON.stringify(exe.id)}, 'open')`), /not opened from here/)
    assert.deepEqual(openedWithApp, [], 'the main process refuses to start a program even when asked directly')
    await click('Reveal in folder')
    for (let index = 0; index < 50 && !revealed.length; index++) await delay(20)
    assert.deepEqual(revealed.splice(0), [join(workspace, 'tool.exe')])
    await click('Copy path')
    for (let index = 0; index < 50 && await clipboard.readText() !== join(workspace, 'tool.exe'); index++) await delay(20)
    assert.equal(await clipboard.readText(), join(workspace, 'tool.exe'))
    assert.deepEqual(await open('archive.zip'), { ok: true })
    await until(`document.querySelector(${JSON.stringify(`${panel} .file-card`)})?.textContent.includes('archive.zip')`, 'card for an archive')
    assert.deepEqual(await buttons(), ['Reload', 'Copy path', 'Reveal in folder', 'Reveal in folder'], 'a file with no viewer is only revealed')
    const zip = (await fileTabs()).find(tab => tab.file.path === 'archive.zip')
    await assert.rejects(ui(`window.copilotDesktop.fileCommand(${JSON.stringify(profileId)}, ${JSON.stringify(zip.id)}, 'open')`), /not opened from here/)
    assert.deepEqual(openedWithApp, [])
    const picture = (await fileTabs()).find(tab => tab.file.path === 'pixel.png')
    await ui(`window.copilotDesktop.fileCommand(${JSON.stringify(profileId)}, ${JSON.stringify(picture.id)}, 'open')`)
    assert.deepEqual(openedWithApp.splice(0), [join(workspace, 'pixel.png')], 'a picture the panel shows can be opened with its app')
    await shot('fallback-card.png')

    // --- PDF: pages drawn, text that can be selected and found, nothing fetched. ---
    assert.equal(await ui('typeof window.copilotFileViewers.pdf'), 'undefined', 'no PDF code is loaded before the first PDF')
    const report = join(workspace, 'docs', 'report.pdf')
    await writeFile(report, makePdf([['Quarterly report alpha', 'Revenue went up'], ['Second page beta', { gbk: 'D6D0CEC4B1A8B8E6' /* 中文报告 */ }], ['Third page gamma']]))
    assert.deepEqual(await open('docs/report.pdf'), { ok: true })
    const pdfText = '[...document.querySelectorAll(' + JSON.stringify(`${panel} .file-pdf .textLayer`) + ')].map(layer => layer.textContent).join("|")'
    await until(`(${pdfText}).includes('Quarterly report alpha')`, 'PDF text layer')
    assert.equal(await ui('typeof window.copilotFileViewers.pdf.open'), 'function')
    const pdfScripts = await ui(`[...document.querySelectorAll('script[src*="viewer-pdf"], link[href*="viewer-pdf"]')].map(element => element.src || element.href)`)
    assert.equal(pdfScripts.length, 2, 'the PDF script and its stylesheet')
    if (asar) assert.ok(pdfScripts.every(url => url.includes('app.asar')), `the PDF viewer came from the packaged archive: ${pdfScripts}`)
    await until(`document.querySelector(${JSON.stringify(`${panel} .file-panel-title span`)})?.textContent.includes('page 1 of 3')`, 'page count')
    // The page is really drawn: its canvas holds dark pixels where the text is.
    const inked = `(() => { const canvas = document.querySelector(${JSON.stringify(`${panel} .file-pdf .page canvas`)}); if (!canvas || !canvas.width) return 0;
      const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, Math.min(canvas.height, 400)).data; let dark = 0;
      for (let index = 0; index < data.length; index += 4) if (data[index + 3] > 0 && data[index] < 90 && data[index + 1] < 90 && data[index + 2] < 90) dark++; return dark })()`
    await until(`${inked} > 200`, 'PDF page drawn with its text')
    assert.equal(await q('.file-pdf .page', 'getComputedStyle(element).position !== "static" && element.getBoundingClientRect().width > 200'), true)
    assert.equal(await ui('getComputedStyle(document.querySelector(".app-shell")).display'), 'grid', 'the PDF stylesheet does not restyle the app')
    // Text can be selected and copied.
    assert.match(await ui(`(() => { const layer = document.querySelector(${JSON.stringify(`${panel} .file-pdf .textLayer`)}); getSelection().selectAllChildren(layer); const text = getSelection().toString(); getSelection().removeAllRanges(); return text })()`), /Quarterly report alpha/)
    // Find goes to the page with the match; Chinese text read through a shipped character map is found too.
    await click('Find')
    const findFor = text => ui(`(() => { const input = document.querySelector(${JSON.stringify(`${panel} .file-find input`)}); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(text)}); input.dispatchEvent(new Event('input',{bubbles:true})) })()`)
    const findStatus = text => `document.querySelector(${JSON.stringify(`${panel} .file-find [role=status]`)})?.textContent === ${JSON.stringify(text)}`
    await findFor('beta')
    await until(findStatus('1 of 1'), 'PDF find result')
    await until(`document.querySelector(${JSON.stringify(`${panel} .file-panel-title span`)})?.textContent.includes('page 2 of 3')`, 'find went to page 2')
    await until(`document.querySelector(${JSON.stringify(`${panel} .file-pdf .textLayer .highlight`)})`, 'the match is marked')
    await findFor('no such words')
    await until(findStatus('No results'), 'no result')
    await findFor('中文')
    await until(findStatus('1 of 1'), 'Chinese text is found')
    assert.equal(await ui(`(${pdfText}).includes('中文报告')`), true, 'text stored in a non-Unicode encoding is read through a shipped character map')
    await click('×')
    // Zoom changes the page size; Fit width brings it back.
    const pageWidth = () => q('.file-pdf .page', 'Math.round(element.getBoundingClientRect().width)')
    const fitted = await pageWidth()
    await click('+')
    await until(`Math.round(document.querySelector(${JSON.stringify(`${panel} .file-pdf .page`)}).getBoundingClientRect().width) > ${fitted + 20}`, 'zoomed in')
    await click('Fit width')
    await until(`Math.abs(Math.round(document.querySelector(${JSON.stringify(`${panel} .file-pdf .page`)}).getBoundingClientRect().width) - ${fitted}) <= 2`, 'fitted again')
    assert.ok((await buttons()).includes('Open with default app'))
    await shot('pdf-view.png')
    // A fax-compressed picture is decoded by the shipped WebAssembly decoder, in the worker: a large black square.
    await writeFile(join(workspace, 'scan.pdf'), makePdf([['Scanned page', { fax: true }]]))
    assert.deepEqual(await open('scan.pdf'), { ok: true })
    await until(`(${pdfText}).includes('Scanned page')`, 'scan text layer')
    const blackArea = `(() => { const canvas = document.querySelector(${JSON.stringify(`${panel} .file-pdf .page canvas`)}); if (!canvas || !canvas.width) return 0;
      const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data; let dark = 0;
      for (let index = 0; index < data.length; index += 4) if (data[index + 3] > 0 && data[index] < 40 && data[index + 1] < 40 && data[index + 2] < 40) dark++; return dark / (canvas.width * canvas.height) })()`
    await until(`${blackArea} > 0.15`, 'fax image decoded and drawn')
    await action({ type: 'close', id: (await fileTabs()).find(tab => tab.file.path === 'scan.pdf').id })
    await action({ type: 'select', id: (await fileTabs()).find(tab => tab.file.path === 'docs/report.pdf').id })
    await until(`(${pdfText}).length > 0`, 'back on the report')
    // The tab follows the file, and stays on its page.
    await writeFile(report, makePdf([['Quarterly report alpha'], ['Second page delta'], ['Third page gamma'], ['Fourth page']]))
    await until(`(${pdfText}).includes('Second page delta')`, 'an edited PDF is shown again')
    await until(`document.querySelector(${JSON.stringify(`${panel} .file-panel-title span`)})?.textContent.includes('page 2 of 4')`, 'still on page 2')
    // Reload opens what is on disk now, even when the file's size and time are what they were.
    const { utimes, stat: statFile } = await import('node:fs/promises')
    const before = await statFile(report)
    const same = makePdf([['Quarterly report alpha'], ['Second page sigma'], ['Third page gamma'], ['Fourth page']])
    assert.equal(same.length, before.size)
    await ui(`window.copilotDesktop.fileWatch(${JSON.stringify(profileId)}, ${JSON.stringify((await fileTabs()).find(tab => tab.file.path === 'docs/report.pdf').id)}, false)`)
    // A whole-second time can be set again exactly, down to the nanosecond.
    const stamp = new Date('2026-01-01T00:00:00Z')
    await utimes(report, stamp, stamp)
    const revisionOf = async () => (await ui(`window.copilotDesktop.fileRead(${JSON.stringify(profileId)}, ${JSON.stringify((await fileTabs()).find(tab => tab.file.path === 'docs/report.pdf').id)}, null).then(result => result.revision)`))
    const stamped = await revisionOf()
    await click('Reload')
    await delay(800)
    await until(`(${pdfText}).includes('Second page delta')`, 'reloaded at the stamped time')
    await writeFile(report, same)
    await utimes(report, stamp, stamp)
    assert.equal(await revisionOf(), stamped, 'new bytes, same size and time: the same revision')
    // An open find is run again in the reloaded document: "delta" is gone from it.
    await click('Find')
    await findFor('delta')
    await until(findStatus('1 of 1'), 'find in the old document')
    await click('Reload')
    await until(`(${pdfText}).includes('Second page sigma')`, 'Reload opens the fresh bytes')
    await until(findStatus('No results'), 'the open find is run again in the reloaded document')
    // And a query the next version still holds is found again there, without typing it again.
    await findFor('Second page')
    await until(findStatus('1 of 1'), 'find before the second reload')
    await writeFile(report, makePdf([['Quarterly report alpha'], ['Second page omega'], ['Third page gamma'], ['Fourth page']]))
    await utimes(report, stamp, stamp)
    await click('Reload')
    await until(`(${pdfText}).includes('Second page omega')`, 'second reload')
    await delay(600)
    await until(findStatus('1 of 1'), 'the open find is run again and finds its match in the new document')
    await until(`document.querySelector(${JSON.stringify(`${panel} .file-pdf .textLayer .highlight`)})`, 'the match is marked in the new document')
    await click('×')
    // A refresh replaces the view; it does not pile listeners and pages on top of the old one.
    for (const word of ['one', 'two', 'three']) {
      await writeFile(report, makePdf([['Quarterly report alpha'], [`Second page ${word}`], ['Third page gamma'], ['Fourth page']]))
      await click('Reload')
      await until(`(${pdfText}).includes('Second page ${word}')`, `refresh ${word}`)
    }
    assert.equal(await q('.file-pdf-pages', 'element.querySelectorAll(".pdfViewer").length'), 1)
    assert.equal(await q('.file-pdf-pages', 'element.querySelectorAll(".page").length'), 4)
    win.webContents.debugger.attach('1.3')
    const node = await win.webContents.debugger.sendCommand('Runtime.evaluate', { expression: `document.querySelector(${JSON.stringify(`${panel} .file-pdf-pages`)})` })
    const { listeners } = await win.webContents.debugger.sendCommand('DOMDebugger.getEventListeners', { objectId: node.result.objectId })
    win.webContents.debugger.detach()
    assert.equal(listeners.filter(listener => listener.type === 'scroll').length, 1, 'one scroll listener after several refreshes')
    // Hidden and shown again, it is laid out for the panel.
    await action({ type: 'visible', visible: false })
    await until(`!document.querySelector(${JSON.stringify(panel)})`, 'panel hidden')
    await action({ type: 'visible', visible: true })
    await until(`document.querySelector(${JSON.stringify(`${panel} .file-pdf .page`)})?.getBoundingClientRect().width > 200`, 'PDF laid out after showing')
    // Documents that cannot be shown get the card: not a PDF inside, protected, or over the size limit.
    await writeFile(join(workspace, 'broken.pdf'), '%PDF-1.7\nthis is not a document\n')
    assert.deepEqual(await open('broken.pdf'), { ok: true })
    await until(`document.querySelector(${JSON.stringify(`${panel} .file-card`)})?.textContent.includes('not a readable PDF')`, 'card for a broken PDF')
    assert.equal(await q('.file-pdf', 'element.hidden'), true)
    await writeFile(join(workspace, 'locked.pdf'), makePdf([['secret']], { encrypt: true }))
    assert.deepEqual(await open('locked.pdf'), { ok: true })
    await until(`document.querySelector(${JSON.stringify(`${panel} .file-card`)})?.textContent.includes('protected with a password')`, 'card for a protected PDF')
    assert.equal(await ui(`(${pdfText}).includes('secret')`), false)
    await writeFile(join(workspace, 'huge.pdf'), makePdf([['big']]))
    await truncate(join(workspace, 'huge.pdf'), 50 * 1024 * 1024 + 1)
    assert.deepEqual(await open('huge.pdf'), { ok: true })
    await until(`document.querySelector(${JSON.stringify(`${panel} .file-card`)})?.textContent.includes('too large')`, 'card for an oversized PDF')
    // A broken file that is repaired shows up; a tab closed while its document is still loading leaves nothing behind.
    await writeFile(join(workspace, 'broken.pdf'), makePdf([['Repaired document']]))
    const brokenTab = (await fileTabs()).find(tab => tab.file.path === 'broken.pdf')
    await action({ type: 'select', id: brokenTab.id })
    await until(`(${pdfText}).includes('Repaired document')`, 'a repaired PDF is shown')
    await writeFile(join(workspace, 'closing.pdf'), makePdf(Array.from({ length: 300 }, (_, index) => [`Page ${index + 1}`])))
    assert.deepEqual(await open('closing.pdf'), { ok: true })
    const closing = (await fileTabs()).find(tab => tab.file.path === 'closing.pdf')
    await action({ type: 'close', id: closing.id })
    await delay(600)
    for (const name of ['docs/report.pdf', 'broken.pdf', 'locked.pdf', 'huge.pdf']) await action({ type: 'close', id: (await fileTabs()).find(tab => tab.file.path === name).id })
    assert.deepEqual(requests, [], 'no PDF caused a network request')
    assert.deepEqual(await ui('window.copilotDesktop.viewerAsset("cMapUrl", "../../app.js").then(() => "served", () => "refused")'), 'refused')

    // --- Tables, Word documents and notebooks. ---
    const { makeDocx, makeXlsx, makeZip } = await import('../dist/src/main/fixtures/office-fixture.js')
    const closeTab = async name => action({ type: 'close', id: (await fileTabs()).find(tab => tab.file.path === name).id })
    const view = `document.querySelector(${JSON.stringify(`${panel} .file-markdown`)})`
    const cells = `[...(${view}?.querySelectorAll('tbody tr') ?? [])].map(row => [...row.querySelectorAll('td')].map(cell => cell.textContent).join('|')).join(';')`

    // CSV: a table with the first row as its head; cells are text, whatever they hold.
    await writeFile(join(workspace, 'people.csv'), 'name,note,amount\n"Smith, J","said ""hi""",12.5\n"<img src=x onerror=""window.pwned=5"">",<script>window.pwned=6</script>,-3\n')
    assert.deepEqual(await open('people.csv'), { ok: true })
    await until(`${view}?.querySelector('table.file-sheet')`, 'CSV table')
    assert.equal(await ui(`[...${view}.querySelectorAll('thead th')].map(cell => cell.textContent).join('|')`), '|name|note|amount')
    assert.equal(await ui(cells), 'Smith, J|said "hi"|12.5;<img src=x onerror="window.pwned=5">|<script>window.pwned=6</script>|-3')
    assert.equal(await ui(`${view}.querySelectorAll('img, script').length`), 0)
    assert.equal(await ui(`getComputedStyle(${view}.querySelector('td.file-cell-number')).textAlign`), 'right')
    await click('Source')
    await until(`document.querySelector(${JSON.stringify(`${panel} .file-code`)})?.textContent.includes('"Smith, J"')`, 'CSV source')
    await click('Table')
    await until(`${view}?.querySelector('table.file-sheet')`, 'CSV table again')
    await writeFile(join(workspace, 'people.csv'), 'name;city\nAda;London\n')
    await until(`(${cells}) === 'Ada|London'`, 'an edited CSV, now separated by semicolons')
    await writeFile(join(workspace, 'tabs.tsv'), 'a\tb,c\n1\t2\n')
    assert.deepEqual(await open('tabs.tsv'), { ok: true })
    await until(`(${cells}) === '1|2'`, 'TSV table')
    assert.equal(await ui(`[...${view}.querySelectorAll('thead th')].map(cell => cell.textContent).join('|')`), '|a|b,c')

    // Excel: every sheet, values only, dates as dates.
    await writeFile(join(workspace, 'budget.xlsx'), await makeXlsx([
      { name: 'Sales', rows: [['Region', 'Amount', 'When'], ['North <b>bold</b>', 1200.5, { date: 45292 }], ['South', { formula: 'B2*2', value: 2401 }, null]] },
      { name: 'Notes', rows: [['Second sheet text']] }]))
    assert.deepEqual(await open('budget.xlsx'), { ok: true })
    await until(`(${cells}).includes('1200.5')`, 'Excel sheet')
    assert.equal(await ui(cells), 'Region|Amount|When;North <b>bold</b>|1200.5|2024-01-01;South|2401|')
    assert.equal(await ui(`[...${view}.querySelectorAll('thead th')].map(cell => cell.textContent).join('|')`), '|A|B|C')
    assert.equal(await ui(`${view}.querySelectorAll('b').length`), 0)
    assert.equal(await ui(`[...document.querySelectorAll(${JSON.stringify(`${panel} .file-sheet-tabs [role=tab]`)})].map(tab => tab.textContent).join('|')`), 'Sales|Notes')
    await click('Notes')
    await until(`(${cells}) === 'Second sheet text'`, 'second sheet')
    await click('Sales')
    await click('Find')
    await findFor('north')
    await until(findStatus('1 of 1'), 'find in a sheet')
    await click('×')
    assert.ok((await buttons()).includes('Open with default app'))
    await shot('excel-view.png')
    await writeFile(join(workspace, 'broken.xlsx'), await makeZip({ 'readme.txt': 'no workbook here' }))
    assert.deepEqual(await open('broken.xlsx'), { ok: true })
    await until(`document.querySelector(${JSON.stringify(`${panel} .file-card`)})?.textContent.includes('could not be read')`, 'card for a ZIP that is not a workbook')

    // Word: headings, bold, a table, a picture; links are never made dangerous.
    await writeFile(join(workspace, 'letter.docx'), await makeDocx([{ heading: 'Project letter' }, { text: 'Plain and ' }, { text: 'bold words', bold: true },
      { table: [['Item', 'Cost'], ['Paper', '12']] }, { link: 'our site', to: 'https://example.com/docs' }, { link: 'bad link', to: 'javascript:window.pwned=7' }, { picture: true }]))
    assert.deepEqual(await open('letter.docx'), { ok: true })
    await until(`${view}?.querySelector('h1')?.textContent === 'Project letter'`, 'Word document')
    assert.equal(await ui(`${view}.querySelector('strong').textContent`), 'bold words')
    assert.equal(await ui(`[...${view}.querySelectorAll('table td')].map(cell => cell.textContent).join('|')`), 'Item|Cost|Paper|12')
    await until(`${view}.querySelector('img')?.naturalWidth === 2`, 'the picture inside the document')
    assert.match(await ui(`${view}.querySelector('img').getAttribute('src')`), /^data:image\/png;base64,/)
    assert.equal(await ui(`[...${view}.querySelectorAll('a')].some(link => /javascript:/i.test(link.getAttribute('href') ?? ''))`), false)
    assert.equal(await ui(`${view}.querySelectorAll('script, iframe, [style], [onclick]').length`), 0)
    external.length = 0
    await ui(`${view}.querySelector('a[href="https://example.com/docs"]').click()`)
    for (let index = 0; index < 50 && !external.length; index++) await delay(20)
    assert.deepEqual(external, ['https://example.com/docs'])
    await ui(`[...${view}.querySelectorAll('a')].find(link => link.textContent === 'bad link').click()`)
    await delay(200)
    assert.ok(win.webContents.getURL().endsWith('index.html'))
    await shot('word-view.png')
    await writeFile(join(workspace, 'letter.docx'), await makeDocx([{ heading: 'Second draft' }]))
    await until(`${view}?.querySelector('h1')?.textContent === 'Second draft'`, 'an edited Word document')
    await writeFile(join(workspace, 'notword.docx'), await makeZip({ 'xl/workbook.xml': '<workbook/>' }))
    assert.deepEqual(await open('notword.docx'), { ok: true })
    await until(`document.querySelector(${JSON.stringify(`${panel} .file-card`)})?.textContent.includes('could not be read')`, 'card for a ZIP that is not a Word document')
    // A document whose main part unpacks to far more than the limit is refused before the converter sees it.
    await writeFile(join(workspace, 'bomb.docx'), await makeZip({ 'word/document.xml': Buffer.alloc(120 * 1024 * 1024, 0x20) }))
    assert.deepEqual(await open('bomb.docx'), { ok: true })
    await until(`document.querySelector(${JSON.stringify(`${panel} .file-card`)})?.textContent.includes('too large')`, 'card for a document that unpacks too large')
    // A tab closed while its document is still being read ends the work.
    await writeFile(join(workspace, 'slow.docx'), await makeDocx(Array.from({ length: 4000 }, (_, index) => ({ text: `Paragraph ${index}` }))))
    assert.deepEqual(await open('slow.docx'), { ok: true })
    await closeTab('slow.docx')

    // Notebook: cells rendered, saved outputs shown, nothing a notebook saved as HTML or script is put in the page.
    const pngBase64 = (await readFile(join(workspace, 'pixel.png'))).toString('base64')
    await writeFile(join(workspace, 'analysis.ipynb'), JSON.stringify({ nbformat: 4, nbformat_minor: 5, metadata: { language_info: { name: 'python' } }, cells: [
      { cell_type: 'markdown', source: ['# Analysis title\n', '\n', 'Some *notes*.<script>window.pwned = 8</script>'] },
      { cell_type: 'code', execution_count: 3, source: 'import math\nprint(math.pi)', outputs: [
        { output_type: 'stream', name: 'stdout', text: ['3.141592653589793\n'] },
        { output_type: 'display_data', data: { 'image/png': pngBase64, 'text/plain': ['<Figure>'] } },
        { output_type: 'execute_result', data: { 'text/html': '<script>window.pwned = 9</script><b>html table</b>', 'text/plain': 'plain form of the table' } },
        { output_type: 'display_data', data: { 'text/html': '<img src=x onerror="window.pwned = 10">' } },
        { output_type: 'error', ename: 'ZeroDivisionError', evalue: 'division by zero', traceback: ['\u001b[0;31mZeroDivisionError\u001b[0m: division by zero'] }] },
    ] }))
    assert.deepEqual(await open('analysis.ipynb'), { ok: true })
    await until(`${view}?.querySelector('h1')?.textContent === 'Analysis title'`, 'notebook rendered')
    assert.equal(await ui(`${view}.classList.contains('file-notebook')`), true)
    assert.equal(await ui(`${view}.querySelector('.file-nb-prompt').textContent`), 'In [3]:')
    assert.equal(await ui(`${view}.querySelector('.file-nb-code pre.hljs .hljs-keyword').textContent`), 'import')
    const streams = await ui(`[...${view}.querySelectorAll('.file-nb-stream')].map(node => node.textContent.trim())`)
    assert.deepEqual(streams, ['3.141592653589793', 'plain form of the table', 'ZeroDivisionError: division by zero'])
    await until(`${view}.querySelector('img.file-nb-picture')?.naturalWidth === 2`, 'saved picture output')
    assert.match(await ui(`${view}.querySelector('.file-nb-note').textContent`), /saved as HTML or a widget/)
    assert.equal(await ui(`${view}.querySelectorAll('script, b, img:not(.file-nb-picture), [onerror]').length`), 0)
    assert.equal(await ui('window.pwned'), undefined, 'nothing from a table, document or notebook ran')
    await shot('notebook-view.png')
    await click('Source')
    await until(`document.querySelector(${JSON.stringify(`${panel} .file-code`)})?.textContent.includes('"nbformat"')`, 'notebook source')
    await writeFile(join(workspace, 'broken.ipynb'), '{ "cells": [ this is not JSON')
    assert.deepEqual(await open('broken.ipynb'), { ok: true })
    await until(`document.querySelector(${JSON.stringify(`${panel} .file-panel-notice`)})?.textContent.includes('Showing its source')`, 'a notebook that is not JSON says so')
    await until(`document.querySelector(${JSON.stringify(`${panel} .file-code`)})?.textContent.includes('this is not JSON')`, 'and shows its text')
    for (const name of ['people.csv', 'tabs.tsv', 'budget.xlsx', 'broken.xlsx', 'letter.docx', 'notword.docx', 'bomb.docx', 'analysis.ipynb', 'broken.ipynb']) await closeTab(name)
    assert.deepEqual(requests, [], 'no table, document or notebook caused a network request')

    // --- Live refresh: an edit, hide-edit-show, and a save by rename. ---
    const notes = join(workspace, 'folder with spaces', 'notes.txt')
    const notesTab = (await fileTabs()).find(tab => tab.file.path === 'folder with spaces/notes.txt')
    await action({ type: 'select', id: notesTab.id })
    const shows = text => `document.querySelector(${JSON.stringify(`${panel} .file-code`)})?.textContent.includes(${JSON.stringify(text)})`
    await until(shows('plain notes'), 'notes shown')
    await writeFile(notes, 'edited while shown\n')
    await until(shows('edited while shown'), 'an edit appears by itself')
    await action({ type: 'visible', visible: false })
    await until(`!document.querySelector(${JSON.stringify(panel)})`, 'panel hidden')
    await delay(400)
    await writeFile(notes, 'edited while hidden\n')
    await delay(600)
    await action({ type: 'visible', visible: true })
    await until(shows('edited while hidden'), 'an edit made while hidden appears when shown')
    await writeFile(`${notes}.tmp`, 'saved by rename\n')
    await rename(`${notes}.tmp`, notes)
    await until(shows('saved by rename'), 'a save that replaces the file')
    await writeFile(notes, 'edited after the rename\n')
    await until(shows('edited after the rename'), 'still watched after the file was replaced')
    await rm(notes)
    await until(`document.querySelector(${JSON.stringify(`${panel} .file-panel-status`)})?.textContent.includes('no longer exists')`, 'a deleted file says so')
    await writeFile(notes, 'back again\n')
    await until(shows('back again'), 'a file that comes back is shown again')

    // --- The cap: the 21st file is refused, nothing is closed for it. ---
    for (let index = 0; index < 20; index++) await writeFile(join(workspace, `extra-${index}.txt`), `extra ${index}\n`)
    let limit = null
    for (let index = 0; index < 20 && !limit; index++) { const result = await open(`extra-${index}.txt`); if (!result.ok) limit = result }
    assert.equal(limit?.reason, 'limit')
    assert.match(limit.message, /20 files are already open/)
    assert.equal((await fileTabs()).length, 20)
    for (const tab of (await fileTabs()).filter(tab => tab.file.path.startsWith('extra-'))) await action({ type: 'close', id: tab.id })
    assert.equal((await fileTabs()).length, 7)

    // --- The Git panel's Open file uses the same tabs. ---
    assert.deepEqual(await open('src/app.ts', null, { profileId, folder: workspace }), { ok: true })
    assert.equal((await fileTabs()).length, 7)
    assert.deepEqual(await open('../outside/secret.txt', null, { profileId, folder: workspace }), { ok: false, reason: 'outside-workspace' })

    // --- Two worktrees hold different versions of the same relative path: two tabs. ---
    const linkedSession = await ui(`window.copilotDesktop.createTab('new',${JSON.stringify(profileId)},'Worktree session', {worktreePath:${JSON.stringify(worktree)}}).then(state => state.activeTabId)`)
    assert.deepEqual(await open('src/app.ts', { line: 2 }, { tabId: linkedSession }), { ok: true })
    await until(shows('worktree version'), 'the worktree file')
    const apps = (await fileTabs()).filter(tab => tab.file.path === 'src/app.ts')
    assert.equal(apps.length, 2, 'same relative path, two roots, two tabs')
    assert.deepEqual(apps.map(tab => tab.file.root).sort(), [worktree, workspace].sort())
    await action({ type: 'select', id: apps.find(tab => tab.file.root === workspace).id })
    await until(shows('main version'), 'the main file is still its own tab')
    await ui(`window.copilotDesktop.unloadTab(${JSON.stringify(linkedSession)})`)

    // Leave only the two app.ts tabs for the restart pass.
    for (const tab of await fileTabs()) if (tab.file.path !== 'src/app.ts') await action({ type: 'close', id: tab.id })
    assert.equal((await fileTabs()).length, 2)
    await delay(800)
    const saved = JSON.parse(await readFile(join(directory, 'userdata', 'workspace-tool-tabs-v2.json'), 'utf8'))
    const savedFiles = saved.projects[0].tabs.filter(tab => tab.kind === 'file')
    assert.deepEqual(savedFiles.map(tab => Object.keys(tab.file).sort()), [['path', 'root'], ['path', 'root']], 'only the root and the path are saved')
    assert.deepEqual(errors.filter(quiet), [])
    console.log('PASS 1: File tab views, safety, refresh, limit, worktrees')
    app.exit(0)
  }
}

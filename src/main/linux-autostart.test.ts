import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { linuxAutostartEnabled, linuxAutostartEntry, linuxAutostartPath, setLinuxAutostart } from './linux-autostart.js'

test('the autostart entry lives in XDG_CONFIG_HOME, or ~/.config when it is unset or relative', () => {
  assert.equal(linuxAutostartPath({ XDG_CONFIG_HOME: '/cfg' }, '/home/me'), join('/cfg', 'autostart', 'copilot-cli-desktop.desktop'))
  assert.equal(linuxAutostartPath({}, '/home/me'), join('/home/me', '.config', 'autostart', 'copilot-cli-desktop.desktop'))
  assert.equal(linuxAutostartPath({ XDG_CONFIG_HOME: 'relative' }, '/home/me'), join('/home/me', '.config', 'autostart', 'copilot-cli-desktop.desktop'))
})

test('Exec quotes arguments with spaces or reserved characters and escapes percent signs', () => {
  const entry = linuxAutostartEntry('/opt/Copilot CLI Desktop/copilot-cli-desktop', ['--background', '100%'])
  assert.match(entry, /^Exec="\/opt\/Copilot CLI Desktop\/copilot-cli-desktop" --background 100%%$/m)
  assert.match(linuxAutostartEntry('/home/me/a"b$c.AppImage', []), /^Exec="\/home\/me\/a\\"b\\\$c\.AppImage"$/m)
})

test('turning launch at login on and off writes and removes the entry, and a hidden entry counts as off', async () => {
  const root = await mkdtemp(join(tmpdir(), 'autostart-'))
  try {
    const path = join(root, 'autostart', 'copilot-cli-desktop.desktop')
    assert.equal(linuxAutostartEnabled(path), false)
    setLinuxAutostart(true, '/usr/bin/copilot-cli-desktop', ['--background'], path)
    assert.equal(linuxAutostartEnabled(path), true)
    assert.match(await readFile(path, 'utf8'), /^Exec=\/usr\/bin\/copilot-cli-desktop --background$/m)
    await writeFile(path, `${await readFile(path, 'utf8')}Hidden=true\n`)
    assert.equal(linuxAutostartEnabled(path), false)
    setLinuxAutostart(false, '/usr/bin/copilot-cli-desktop', [], path)
    assert.equal(linuxAutostartEnabled(path), false)
    setLinuxAutostart(false, '/usr/bin/copilot-cli-desktop', [], path)
  } finally { await rm(root, { recursive: true, force: true }) }
})

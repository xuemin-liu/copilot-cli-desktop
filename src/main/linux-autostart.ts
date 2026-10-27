import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Launch at login on Linux, where Electron's login items do nothing: an XDG autostart entry that desktop environments run
 * when the person signs in.
 */

export function linuxAutostartPath(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  const config = env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME.startsWith('/') ? env.XDG_CONFIG_HOME : join(home, '.config')
  return join(config, 'autostart', 'copilot-cli-desktop.desktop')
}

/** One `Exec` argument, quoted as the Desktop Entry Specification asks when it holds a space or a reserved character. */
function execArgument(value: string): string {
  if (!/[\s"'\\`$<>~|&;*?#()]/.test(value)) return value.replace(/%/g, '%%')
  return `"${value.replace(/[\\"`$]/g, (character) => `\\${character}`).replace(/%/g, '%%')}"`
}

export function linuxAutostartEntry(executable: string, args: readonly string[]): string {
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Name=Copilot CLI Desktop',
    `Exec=${[executable, ...args].map(execArgument).join(' ')}`,
    'X-GNOME-Autostart-enabled=true',
    'NoDisplay=true',
    '',
  ].join('\n')
}

/** Whether the entry is there and not switched off (`Hidden=true` or GNOME's own flag). */
export function linuxAutostartEnabled(path: string = linuxAutostartPath()): boolean {
  if (!existsSync(path)) return false
  const text = readFileSync(path, 'utf8')
  return !/^Hidden\s*=\s*true\s*$/mi.test(text) && !/^X-GNOME-Autostart-enabled\s*=\s*false\s*$/mi.test(text)
}

export function setLinuxAutostart(enabled: boolean, executable: string, args: readonly string[], path: string = linuxAutostartPath()): void {
  if (!enabled) { rmSync(path, { force: true }); return }
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, linuxAutostartEntry(executable, args), { mode: 0o644 })
}

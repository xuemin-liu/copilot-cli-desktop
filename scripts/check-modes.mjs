export const checkModes = [
  { flag: '--native-paste', env: 'DESKTOP_UI_PASTE_CHECK', module: './native-paste-check.mjs', run: 'runNativePasteCheck', artifacts: 'native-paste', label: 'native image/text paste' },
  { flag: '--popout', env: 'DESKTOP_UI_POPOUT_CHECK', module: './session-popout-check.mjs', run: 'runPopoutCheck', artifacts: 'session-popout', label: 'session pop-out' },
  { flag: '--activity', env: 'DESKTOP_UI_ACTIVITY_CHECK', module: './session-activity-check.mjs', run: 'runActivityCheck', artifacts: 'session-activity', label: 'session activity' },
  { flag: '--permissions', env: 'DESKTOP_UI_PERMISSION_CHECK', module: './session-permission-check.mjs', run: 'runPermissionCheck', artifacts: 'permissions', label: 'session permission' },
  ...['switch', 'multi-click', 'status'].map(variant => ({ flag: `--clipboard-${variant}`, env: 'DESKTOP_UI_CLIPBOARD_CHECK', module: './clipboard-switch-check.mjs', run: 'runClipboardSwitchCheck', artifacts: `clipboard-${variant}`, label: `clipboard ${variant}` })),
]

export function selectCheckMode(args) {
  const selected = checkModes.filter(mode => args.includes(mode.flag))
  if (selected.length > 1) throw new Error(`Choose one check mode: ${selected.map(mode => mode.flag).join(', ')}`)
  return selected[0]
}

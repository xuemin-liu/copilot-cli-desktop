export function writeToTerminalChannel(tab, data, channelId = tab.channelId, api = window.electronAPI) {
  if (tab.isLocal) api.local.write(channelId, data)
  else api.ssh.write(channelId, data)
}

export function resizeTerminalChannel(tab, cols, rows, channelId = tab.channelId, api = window.electronAPI) {
  if (tab.isLocal) api.local.resize(channelId, cols, rows)
  else api.ssh.resize(channelId, cols, rows)
}

export function writeToBroadcastTargets(tabs, data, api = window.electronAPI) {
  tabs.forEach((tab) => writeToTerminalChannel(tab, data, tab.channelId, api))
}

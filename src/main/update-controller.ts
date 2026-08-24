import { EventEmitter } from 'node:events'

export type DesktopUpdateStatus =
  | 'unavailable'
  | 'idle'
  | 'checking'
  | 'up-to-date'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'installing'
  | 'error'

export interface DesktopUpdateState {
  status: DesktopUpdateStatus
  currentVersion: string
  availableVersion: string | null
  downloadPercent: number | null
  message: string
  canCheck: boolean
  canDownload: boolean
  canInstall: boolean
}

export interface UpdateAdapter extends EventEmitter {
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  checkForUpdates(): Promise<unknown>
  downloadUpdate(): Promise<unknown>
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void
}

interface UpdateInfoLike {
  version?: unknown
}

interface DownloadProgressLike {
  percent?: unknown
}

function updateVersion(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null
  const version = (value as UpdateInfoLike).version
  return typeof version === 'string' && version.length > 0 ? version : null
}

export function formatUpdateError(error: unknown): string {
  const raw = (error instanceof Error ? error.message : String(error)).replace(
    /\bhttps?:\/\/[^\s<>"']+/gi,
    (url) => {
      const queryIndex = url.indexOf('?')
      return queryIndex < 0 ? url : `${url.slice(0, queryIndex)}?[REDACTED]`
    },
  )
  if (/\b404\b/.test(raw)) return 'No published desktop release is available yet.'
  if (/ENOTFOUND|ERR_INTERNET_DISCONNECTED|ERR_NETWORK_CHANGED|ETIMEDOUT|ECONNRESET/i.test(raw)) {
    return 'The update service could not be reached. Check your connection and try again.'
  }
  const firstLine = raw.split(/\r?\n/, 1)[0]?.trim() || 'Unknown update error'
  return firstLine.length > 240 ? `${firstLine.slice(0, 237)}…` : firstLine
}

/** Thin, testable wrapper around electron-updater so main.ts can stay declarative. */
export class DesktopUpdateController extends EventEmitter {
  private readonly updater: UpdateAdapter | null
  private readonly currentVersion: string
  private stateValue: DesktopUpdateState

  constructor(updater: UpdateAdapter | null, currentVersion: string, unavailableReason = 'Updates are available in installed builds.') {
    super()
    this.updater = updater
    this.currentVersion = currentVersion
    this.stateValue = updater
      ? this.createState('idle', 'Ready to check for updates.')
      : this.createState('unavailable', unavailableReason)

    if (!updater) return
    updater.autoDownload = false
    updater.autoInstallOnAppQuit = false
    updater.on('checking-for-update', () => this.setState('checking', 'Checking GitHub Releases…'))
    updater.on('update-not-available', () => this.setState('up-to-date', 'You have the latest version.', null))
    updater.on('update-available', (info: unknown) => {
      this.setState('available', 'A new version is available.', updateVersion(info))
    })
    updater.on('download-progress', (progress: DownloadProgressLike) => {
      const percent = typeof progress.percent === 'number'
        ? Math.min(100, Math.max(0, progress.percent))
        : null
      this.setState('downloading', percent === null ? 'Downloading update…' : `Downloading update… ${percent.toFixed(0)}%`, undefined, percent)
    })
    updater.on('update-downloaded', (info: unknown) => {
      this.setState('downloaded', 'Update downloaded. Restart to install it.', updateVersion(info), 100)
    })
    updater.on('error', (error: unknown) => {
      this.setState('error', `Update check failed: ${formatUpdateError(error)}`)
    })
  }

  get snapshot(): DesktopUpdateState {
    return { ...this.stateValue }
  }

  private createState(
    status: DesktopUpdateStatus,
    message: string,
    availableVersion: string | null = null,
    downloadPercent: number | null = null,
  ): DesktopUpdateState {
    return {
      status,
      currentVersion: this.currentVersion,
      availableVersion,
      downloadPercent,
      message,
      canCheck: this.updater !== null && (status === 'idle' || status === 'up-to-date' || status === 'error'),
      canDownload: status === 'available',
      canInstall: status === 'downloaded',
    }
  }

  private setState(
    status: DesktopUpdateStatus,
    message: string,
    availableVersion = this.stateValue.availableVersion,
    downloadPercent: number | null = null,
  ): void {
    this.stateValue = this.createState(status, message, availableVersion, downloadPercent)
    this.emit('state-changed', this.snapshot)
  }

  async check(): Promise<DesktopUpdateState> {
    if (!this.updater) return this.snapshot
    if (this.stateValue.status === 'checking' || this.stateValue.status === 'downloading') return this.snapshot
    this.setState('checking', 'Checking GitHub Releases…')
    try {
      await this.updater.checkForUpdates()
    } catch (error) {
      if (this.snapshot.status !== 'error') {
        this.setState('error', `Update check failed: ${formatUpdateError(error)}`)
      }
    }
    return this.snapshot
  }

  async download(): Promise<DesktopUpdateState> {
    if (!this.updater || this.stateValue.status !== 'available') return this.snapshot
    this.setState('downloading', 'Downloading update…', this.stateValue.availableVersion, 0)
    try {
      await this.updater.downloadUpdate()
    } catch (error) {
      if (this.snapshot.status !== 'error') {
        this.setState('error', `Update download failed: ${formatUpdateError(error)}`)
      }
    }
    return this.snapshot
  }

  install(): void {
    if (!this.updater || this.stateValue.status !== 'downloaded') {
      throw new Error('No downloaded update is ready to install')
    }
    const availableVersion = this.stateValue.availableVersion
    this.setState('installing', 'Installing update…', availableVersion, 100)
    try {
      this.updater.quitAndInstall(false, true)
    } catch (error) {
      this.setState('downloaded', 'Update downloaded. Restart to install it.', availableVersion, 100)
      throw error
    }
  }
}

import type { ComponentType } from 'react'
// Dynamic upstream Zustand actions and IPC shapes are confined to the vendor boundary.
export function projectTerminal(profileId: string): { api: any; store: any; load(): Promise<void>; importSshConfig(): Promise<unknown> }
export const ConnectionSidebar: ComponentType<{host: object}>
export const WorkspaceTabBar: ComponentType<{host: object}>
export const SettingsDialog: ComponentType<{ host: object; onClose(): void }>
export const SessionDialog: ComponentType<{ host: object; session?: object | undefined; onClose(): void }>

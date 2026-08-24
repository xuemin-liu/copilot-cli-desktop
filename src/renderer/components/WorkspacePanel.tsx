import type { JSX } from 'react'
import type { WorkspaceProfile } from '../../main/types.js'

export interface WorkspacePanelProps {
  profiles: WorkspaceProfile[]
  activeProfileId: string | null
  onSelectWorkspace: () => void
  onActivateProfile: (profileId: string) => void
  onOpenSettings: () => void
  onResumePicker: () => void
}

export function WorkspacePanel({
  profiles,
  activeProfileId,
  onSelectWorkspace,
  onActivateProfile,
  onOpenSettings,
  onResumePicker,
}: WorkspacePanelProps): JSX.Element {
  return (
    <div className="workspace-panel">
      <button type="button" className="workspace-button" onClick={onSelectWorkspace}>
        Choose workspace…
      </button>
      {profiles.length > 0 && (
        <select
          className="workspace-select"
          value={activeProfileId ?? ''}
          onChange={(event) => onActivateProfile(event.target.value)}
        >
          {profiles.map((profile) => (
            <option key={profile.id} value={profile.id}>
              {profile.name}
            </option>
          ))}
        </select>
      )}
      <button type="button" className="workspace-button" onClick={onResumePicker} title="Resume a different session with copilot --resume">
        Resume session…
      </button>
      <div className="workspace-spacer" />
      <button type="button" className="workspace-button" onClick={onOpenSettings} title="Desktop Settings (Ctrl+,)">
        ⚙ Settings
      </button>
    </div>
  )
}

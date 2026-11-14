import React from 'react'

export default function FileEditor({ editingFile, onSave, onClose, onChange, textareaRef }) {
  return (
    <div className="file-editor-overlay">
      <div className="file-editor-header">
        <span className="file-editor-path">
          {editingFile.remotePath}
          {editingFile.content !== editingFile.original && <span className="file-editor-modified"> (modified)</span>}
        </span>
        <div className="file-editor-actions">
          <button
            className="btn-primary"
            onClick={onSave}
            disabled={editingFile.content === editingFile.original}
          >
            Save
          </button>
          <button className="btn-secondary" onClick={onClose}>Close</button>
        </div>
      </div>
      <textarea
        ref={textareaRef}
        className="file-editor-textarea"
        value={editingFile.content}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
      />
    </div>
  )
}

import React, { useState } from 'react'
import { Plus, Trash2, Play, X } from 'lucide-react'
import useSessionStore from '../store/useSessionStore'

export default function SnippetPanel({ onInsert, onClose }) {
  const { snippets, addSnippet, deleteSnippet } = useSessionStore()
  const [newName, setNewName] = useState('')
  const [newCmd, setNewCmd] = useState('')
  const [adding, setAdding] = useState(false)

  const handleAdd = () => {
    if (!newCmd.trim()) return
    addSnippet({ name: newName.trim() || newCmd.trim(), command: newCmd.trim() })
    setNewName('')
    setNewCmd('')
    setAdding(false)
  }

  return (
    <div className="snippet-panel">
      <div className="snippet-header">
        <span>Snippets</span>
        <button className="icon-btn" onClick={() => setAdding((v) => !v)} title="Add snippet">
          <Plus size={14} />
        </button>
        <button className="icon-btn" onClick={onClose} title="Close">
          <X size={14} />
        </button>
      </div>
      {adding && (
        <div className="snippet-add-form">
          <input
            placeholder="Name (optional)"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
          />
          <input
            placeholder="Command *"
            value={newCmd}
            onChange={(e) => setNewCmd(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleAdd() }}
            autoFocus
          />
          <button className="btn-primary" style={{ padding: '4px 10px', fontSize: 12 }} onClick={handleAdd}>
            Save
          </button>
        </div>
      )}
      <div className="snippet-list">
        {snippets.length === 0 && (
          <div className="snippet-empty">No snippets — click + to add one</div>
        )}
        {snippets.map((s) => (
          <div key={s.id} className="snippet-item">
            <div className="snippet-text">
              <span className="snippet-name">{s.name}</span>
              <span className="snippet-cmd">{s.command}</span>
            </div>
            <button className="icon-btn" onClick={() => onInsert(s.command)} title="Insert & run">
              <Play size={13} />
            </button>
            <button className="icon-btn danger" onClick={() => deleteSnippet(s.id)} title="Delete">
              <Trash2 size={13} />
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}

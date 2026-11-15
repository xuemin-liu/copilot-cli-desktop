import React, { useState, useRef, useEffect } from 'react'
import { X, Terminal, Plus, Radio, Monitor, Save } from 'lucide-react'
import useSessionStore from '../store/useSessionStore'
import SessionDialog from './SessionDialog'

const TAB_COLORS = ['#58a6ff', '#3fb950', '#d29922', '#ff7b72', '#bc8cff', '#39c5cf', '#f78166', null]

export default function TabBar({ host }) {
  const { tabs, activeTabId, setActiveTab, closeTab, updateTab, addSession, broadcastMode, toggleBroadcast, openLocalTab, openWslTab, reorderTabs } = host ? { ...host.store(), ...host.tabState } : useSessionStore()
  const api = host?.api ?? window.electronAPI
  const [error, setError] = useState('')
  const [quickConnect, setQuickConnect] = useState(false)
  const [tabMenu, setTabMenu] = useState(null)
  const [editLabel, setEditLabel] = useState('')
  const [wslDistros, setWslDistros] = useState([])
  const [wslMenuPos, setWslMenuPos] = useState(null)
  const [dragIdx, setDragIdx] = useState(null)
  const [dragOverIdx, setDragOverIdx] = useState(null)
  const menuRef = useRef(null)
  const wslMenuRef = useRef(null)

  useEffect(() => {
    if (!host && api.platform === 'win32') {
      api.wsl.getDistros().then(setWslDistros)
    }
  }, [])

  useEffect(() => {
    if (!tabMenu) return
    const close = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) setTabMenu(null)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [tabMenu])

  useEffect(() => {
    if (!wslMenuPos) return
    const close = (e) => {
      if (wslMenuRef.current && !wslMenuRef.current.contains(e.target)) setWslMenuPos(null)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [wslMenuPos])

  useEffect(() => { host?.onMenu?.(Boolean(tabMenu)); return () => host?.onMenu?.(false) }, [Boolean(tabMenu)])
  useEffect(() => { if (host && !host.active) setTabMenu(null) }, [host?.active])
  const handleClose = (e, tabId) => {
    e.stopPropagation()
    closeTab(tabId)
  }

  const openTabMenu = (e, tab) => {
    e.preventDefault()
    setError('')
    setTabMenu({ x: Math.max(0, Math.min(e.clientX, window.innerWidth - 240)), y: Math.max(0, Math.min(e.clientY, window.innerHeight - 240)), tabId: tab.id, label: tab.label, color: tab.color, config: tab.config, sessionId: tab.sessionId, isLocal: tab.isLocal })
    setEditLabel(tab.label)
  }

  const handleSaveSession = async () => {
    const { tabId, config } = tabMenu
    try {
      if (host) await host.saveConnection(tabId)
      else { await addSession(config); updateTab(tabId, { sessionId: config.id }) }
      setTabMenu(null)
    } catch (error) { setError(error.message) }
  }

  const applyLabel = () => {
    if (tabMenu) updateTab(tabMenu.tabId, { label: editLabel })
    setTabMenu(null)
  }

  const handleWslOpen = (distro) => {
    openWslTab(distro)
    setWslMenuPos(null)
  }

  const toggleWslMenu = (e) => {
    if (wslMenuPos) { setWslMenuPos(null); return }
    const rect = e.currentTarget.getBoundingClientRect()
    setWslMenuPos({ x: rect.right, y: rect.bottom + 2 })
  }

  return (
    <div className={`tabbar workspace-tools-header ${broadcastMode ? 'broadcasting' : ''}`}>
      <div className="tabbar-tabs tool-tab-strip" role="tablist" aria-label="Workspace tabs" onKeyDown={e => {
        if (!['ArrowLeft','ArrowRight','Home','End'].includes(e.key)) return
        e.preventDefault()
        const index = tabs.findIndex(t => t.id === activeTabId)
        const next = e.key === 'Home' ? tabs[0] : e.key === 'End' ? tabs.at(-1) : tabs[(index + (e.key === 'ArrowLeft' ? -1 : 1) + tabs.length) % tabs.length]
        if (next) { setActiveTab(next.id); e.currentTarget.querySelector(`[data-tab-id="${next.id}"]`)?.focus() }
      }}>
        {tabs.map((tab, idx) => (
          <div
            key={tab.id}
            className={`tab tool-tab ${tab.id === activeTabId ? 'active' : ''}${dragIdx === idx ? ' dragging' : ''}${dragOverIdx === idx ? ' drag-over' : ''}`}
            onContextMenu={(e) => openTabMenu(e, tab)}
            style={tab.color ? { borderBottom: `2px solid ${tab.color}` } : {}}
            draggable
            onDragStart={(e) => { setDragIdx(idx); e.dataTransfer.effectAllowed = 'move' }}
            onDragOver={(e) => { e.preventDefault(); setDragOverIdx(idx) }}
            onDrop={(e) => { e.preventDefault(); if (dragIdx !== null && dragIdx !== idx) reorderTabs(dragIdx, idx); setDragIdx(null); setDragOverIdx(null) }}
            onDragEnd={() => { setDragIdx(null); setDragOverIdx(null) }}
          >
            {tab.color && <span className="tab-color-dot" style={{ background: tab.color }} />}
            <button type="button" role="tab" data-tab-id={tab.id} aria-selected={tab.id === activeTabId} aria-controls={`tool-content-${tab.id}`} tabIndex={tab.id === activeTabId ? 0 : -1} title={tab.label} onClick={() => setActiveTab(tab.id)}>
              <span className="tab-label">{tab.label}</span>
            </button>
            <button className="tab-close tool-tab-close" aria-label={`Close ${tab.label} tab`} onClick={(e) => handleClose(e, tab.id)} title="Close tab">
              <X size={12} />
            </button>
          </div>
        ))}
      </div>

      <div className="tabbar-actions">
        <button
          className={`icon-btn ${broadcastMode ? 'active broadcast-active' : ''}`}
          onClick={toggleBroadcast}
          aria-label="Broadcast terminal input" aria-pressed={broadcastMode}
          disabled={host && !tabs.some(tab => tab.terminal)}
          title={broadcastMode ? 'Broadcast ON — click to disable' : 'Broadcast: send input to all connected terminal tabs in this project'}
        >
          <Radio size={15} />{broadcastMode && <span>Broadcast ON</span>}
        </button>

        {!host && <>
        {/* WSL button — only shown on Windows with WSL distros available */}
        {wslDistros.length > 0 && (
          <>
            <button
              className={`icon-btn ${wslMenuPos ? 'active' : ''}`}
              onClick={toggleWslMenu}
              title="New WSL terminal"
              style={{ fontSize: 10, gap: 2, display: 'flex', alignItems: 'center' }}
            >
              <Terminal size={13} />
              <span style={{ fontSize: 9, lineHeight: 1, opacity: 0.85 }}>WSL</span>
            </button>
            {wslMenuPos && (
              <div ref={wslMenuRef} className="context-menu" style={{ top: wslMenuPos.y, right: window.innerWidth - wslMenuPos.x, width: 150 }}>
                {wslDistros.map((d) => (
                  <button key={d} onClick={() => handleWslOpen(d)}>
                    <Terminal size={12} /> {d}
                  </button>
                ))}
              </div>
            )}
          </>
        )}

        <button className="icon-btn" onClick={openLocalTab} title="New local terminal">
          <Monitor size={15} />
        </button>
        <button className="tab-new" onClick={() => setQuickConnect(true)} title="Quick connect">
          <Plus size={16} />
        </button>
        </>}
        {host?.toolbar}
      </div>

      {/* Tab right-click menu */}
      {tabMenu && (
        <div ref={menuRef} className="context-menu tab-ctx-menu" style={{ top: tabMenu.y, left: tabMenu.x }} onKeyDown={e => { e.stopPropagation(); if(e.key === 'Escape') setTabMenu(null) }}>
          {error && <p role="alert">{error}</p>}
          {!tabMenu.sessionId && !tabMenu.isLocal && tabMenu.config && (
            <button onClick={handleSaveSession}><Save size={13} /> Save connection</button>
          )}
          <div className="ctx-section">
            <div className="ctx-label">Rename</div>
            <input
              className="ctx-input" aria-label="Tab name" maxLength={128}
              value={editLabel}
              autoFocus
              onChange={(e) => setEditLabel(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') applyLabel() }}
            />
          </div>
          <div className="ctx-section">
            <div className="ctx-label">Color</div>
            <div className="color-swatches">
              {TAB_COLORS.map((c, i) => (
                <button
                  key={i}
                  className={`color-swatch ${tabMenu.color === c ? 'selected' : ''}`}
                  style={{ background: c || 'transparent', border: c ? 'none' : '1px dashed #484f58' }}
                  onClick={() => { updateTab(tabMenu.tabId, { color: c }); setTabMenu(null) }}
                  title={c || 'None'}
                />
              ))}
            </div>
          </div>
          <button onClick={applyLabel}>Apply rename</button>
        </div>
      )}

      {quickConnect && <SessionDialog session={null} onClose={() => setQuickConnect(false)} />}
    </div>
  )
}

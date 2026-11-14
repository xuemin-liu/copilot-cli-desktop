import React, { useState, useEffect } from 'react'
import { Plus, X, Play, Square } from 'lucide-react'

const TYPES = [
  { value: 'local', label: 'Local (L)' },
  { value: 'remote', label: 'Remote (R)' },
  { value: 'dynamic', label: 'Dynamic (D)' },
]

export default function TunnelPanel({ channelId, sessionId, onClose }) {
  const [tunnels, setTunnels] = useState([]) // { id, type, config, running }
  const [form, setForm] = useState({ type: 'local', localPort: '', remoteHost: 'localhost', remotePort: '', localHost: '127.0.0.1' })
  const [error, setError] = useState(null)

  useEffect(() => {
    if (!sessionId) return
    Promise.all([
      window.electronAPI.tunnel.getConfigs(sessionId),
      window.electronAPI.tunnel.list(),
    ]).then(([configs, activeTunnels]) => {
      const activeIds = new Set(activeTunnels.map((t) => t.id))
      setTunnels((configs || []).map((c) => ({ ...c, running: activeIds.has(c.id) })))
    })
  }, [sessionId])

  const saveConfigs = (list) => {
    if (sessionId) {
      const toSave = list.map(({ id, type, config }) => ({ id, type, config }))
      window.electronAPI.tunnel.setConfigs(sessionId, toSave)
    }
  }

  const addTunnel = () => {
    const id = crypto.randomUUID()
    const config = { ...form, localPort: parseInt(form.localPort) || 0, remotePort: parseInt(form.remotePort) || 0 }
    const entry = { id, type: form.type, config, running: false }
    const updated = [...tunnels, entry]
    setTunnels(updated)
    saveConfigs(updated)
    setForm({ type: 'local', localPort: '', remoteHost: 'localhost', remotePort: '', localHost: '127.0.0.1' })
  }

  const removeTunnel = async (id) => {
    const t = tunnels.find((x) => x.id === id)
    if (t?.running) await window.electronAPI.tunnel.stop(id)
    const updated = tunnels.filter((x) => x.id !== id)
    setTunnels(updated)
    saveConfigs(updated)
  }

  const toggleTunnel = async (id) => {
    const t = tunnels.find((x) => x.id === id)
    if (!t) return
    setError(null)
    if (t.running) {
      await window.electronAPI.tunnel.stop(id)
      setTunnels((prev) => prev.map((x) => x.id === id ? { ...x, running: false } : x))
    } else {
      const result = await window.electronAPI.tunnel.start(channelId, id, { type: t.type, ...t.config })
      if (result?.error) { setError(result.error); return }
      setTunnels((prev) => prev.map((x) => x.id === id ? { ...x, running: true } : x))
    }
  }

  const formatTunnel = (t) => {
    const c = t.config
    if (t.type === 'local') return `L ${c.localPort} → ${c.remoteHost}:${c.remotePort}`
    if (t.type === 'remote') return `R ${c.remotePort} → ${c.localHost || '127.0.0.1'}:${c.localPort}`
    if (t.type === 'dynamic') return `D :${c.localPort} (SOCKS5)`
    return '?'
  }

  return (
    <div className="tunnel-panel">
      <div className="snippet-header">
        <span>Port Forwarding</span>
        <button className="icon-btn" onClick={onClose}><X size={14} /></button>
      </div>

      {error && <div className="sftp-error">{error}</div>}

      <div className="tunnel-form">
        <select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
          {TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
        </select>
        <input
          type="number" placeholder="Local port"
          value={form.localPort}
          onChange={(e) => setForm({ ...form, localPort: e.target.value })}
        />
        {form.type === 'local' && (
          <>
            <input
              placeholder="Remote host"
              value={form.remoteHost}
              onChange={(e) => setForm({ ...form, remoteHost: e.target.value })}
            />
            <input
              type="number" placeholder="Remote port"
              value={form.remotePort}
              onChange={(e) => setForm({ ...form, remotePort: e.target.value })}
            />
          </>
        )}
        {form.type === 'remote' && (
          <>
            <input
              type="number" placeholder="Remote port"
              value={form.remotePort}
              onChange={(e) => setForm({ ...form, remotePort: e.target.value })}
            />
            <input
              placeholder="Local host"
              value={form.localHost}
              onChange={(e) => setForm({ ...form, localHost: e.target.value })}
            />
          </>
        )}
        <button className="icon-btn" onClick={addTunnel} title="Add tunnel"><Plus size={14} /></button>
      </div>

      <div className="tunnel-list">
        {tunnels.length === 0 && <div className="snippet-empty">No tunnels configured</div>}
        {tunnels.map((t) => (
          <div key={t.id} className={`tunnel-item ${t.running ? 'running' : ''}`}>
            <button className="icon-btn" onClick={() => toggleTunnel(t.id)} title={t.running ? 'Stop' : 'Start'}>
              {t.running ? <Square size={12} /> : <Play size={12} />}
            </button>
            <span className={`tunnel-status-dot ${t.running ? 'active' : ''}`} />
            <span className="tunnel-desc">{formatTunnel(t)}</span>
            <button className="icon-btn danger" onClick={() => removeTunnel(t.id)} title="Remove"><X size={12} /></button>
          </div>
        ))}
      </div>
    </div>
  )
}

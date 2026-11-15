import React, { useState, useEffect } from 'react'
import { X, Key, Lock, Server } from 'lucide-react'
import useSessionStore from '../store/useSessionStore'

const DEFAULT_FORM = {
  name: '', host: '', port: '22', username: '',
  authType: 'password', password: '', keyPath: '', passphrase: '',
  group: '',
  useJump: false,
  jumpHost: '', jumpPort: '22', jumpUsername: '',
  jumpAuthType: 'password', jumpPassword: '', jumpKeyPath: '', jumpPassphrase: '',
}

export default function SessionDialog({ host, session, onClose }) {
  const api = host?.api || window.electronAPI
  const sessionStore = host?.store || useSessionStore
  const { addSession, updateSession, openTab } = sessionStore()
  const [form, setForm] = useState(DEFAULT_FORM)
  const [error, setError] = useState('')

  useEffect(() => {
    if (session) {
      setForm({
        name: session.name || '',
        host: session.host || '',
        port: String(session.port || 22),
        username: session.username || '',
        authType: session.authType || 'password',
        password: session.password || '',
        keyPath: session.keyPath || '',
        passphrase: session.passphrase || '',
        group: session.group || '',
        useJump: !!(session.jumpHost),
        jumpHost: session.jumpHost || '',
        jumpPort: String(session.jumpPort || 22),
        jumpUsername: session.jumpUsername || '',
        jumpAuthType: session.jumpAuthType || 'password',
        jumpPassword: session.jumpPassword || '',
        jumpKeyPath: session.jumpKeyPath || '',
        jumpPassphrase: session.jumpPassphrase || '',
      })
    }
  }, [session])

  const set = (field, value) => setForm((f) => ({ ...f, [field]: value }))

  const putSecret = (data, field, value, active) => {
    if (!active) {
      data[field] = ''
      return
    }
    if (!session || value) data[field] = value
  }

  const buildData = () => {
    const data = {
      id: session?.id || crypto.randomUUID(),
      name: form.name || `${form.username}@${form.host}${parseInt(form.port, 10) !== 22 ? ':' + form.port : ''}`,
      host: form.host,
      port: parseInt(form.port, 10) || 22,
      username: form.username,
      authType: form.authType,
      keyPath: form.authType === 'key' ? form.keyPath : '',
      group: form.group,
    }
    putSecret(data, 'password', form.password, form.authType === 'password')
    putSecret(data, 'passphrase', form.passphrase, form.authType === 'key')

    if (form.useJump && form.jumpHost) {
      data.jumpHost = form.jumpHost
      data.jumpPort = parseInt(form.jumpPort, 10) || 22
      data.jumpUsername = form.jumpUsername
      data.jumpAuthType = form.jumpAuthType
      data.jumpKeyPath = form.jumpAuthType === 'key' ? form.jumpKeyPath : ''
      putSecret(data, 'jumpPassword', form.jumpPassword, form.jumpAuthType === 'password')
      putSecret(data, 'jumpPassphrase', form.jumpPassphrase, form.jumpAuthType === 'key')
    } else {
      data.jumpPassword = ''
      data.jumpPassphrase = ''
    }
    return data
  }

  const handleSave = async () => {
    try {
    if (!form.host || !form.username) return
    const data = buildData()
    if (session) await updateSession(data)
    else await addSession(data)
    onClose()
    } catch (error) { setError(error.message) }
  }

  const handleConnect = async () => {
    try {
    if (!form.host || !form.username) return
    await openTab(buildData())
    onClose()
    } catch (error) { setError(error.message) }
  }

  const browseKeyFile = async (field) => {
    const result = await api.dialog.openFile({
      title: 'Select Private Key File',
      properties: ['openFile'],
    })
    if (!result.canceled && result.filePaths.length > 0) set(field, result.filePaths[0])
  }

  return (
    <div className="dialog-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog">
        <div className="dialog-header">
          <h2>{session ? 'Edit SSH connection' : 'New SSH connection'}</h2>
          <button className="icon-btn" onClick={onClose}><X size={16} /></button>
        </div>
        <div className="dialog-body">
          {error && <p role="alert">{error}</p>}
          <div className="form-group">
            <label>Name (optional)</label>
            <input type="text" placeholder="My Server" value={form.name}
              onChange={(e) => set('name', e.target.value)} />
          </div>
          <div className="form-group">
            <label>Group (optional)</label>
            <input type="text" placeholder="Production, Dev, …" value={form.group}
              onChange={(e) => set('group', e.target.value)} />
          </div>
          <div className="form-row">
            <div className="form-group flex-1">
              <label>Host *</label>
              <input type="text" placeholder="192.168.1.1" value={form.host}
                onChange={(e) => set('host', e.target.value)} />
            </div>
            <div className="form-group" style={{ width: 80 }}>
              <label>Port</label>
              <input type="number" value={form.port} onChange={(e) => set('port', e.target.value)} />
            </div>
          </div>
          <div className="form-group">
            <label>Username *</label>
            <input type="text" placeholder="root" value={form.username}
              onChange={(e) => set('username', e.target.value)} />
          </div>

          <div className="form-group">
            <label>Authentication</label>
            <div className="auth-toggle">
              <button className={form.authType === 'password' ? 'active' : ''} onClick={() => set('authType', 'password')}>
                <Lock size={13} /> Password
              </button>
              <button className={form.authType === 'key' ? 'active' : ''} onClick={() => set('authType', 'key')}>
                <Key size={13} /> Private Key
              </button>
            </div>
          </div>

          {form.authType === 'password' ? (
            <div className="form-group">
              <label>Password</label>
              <input type="password" placeholder="••••••••" value={form.password}
                onChange={(e) => set('password', e.target.value)} />
            </div>
          ) : (
            <>
              <div className="form-group">
                <label>Key File</label>
                <div className="input-row">
                  <input type="text" placeholder="/home/user/.ssh/id_rsa" value={form.keyPath} readOnly />
                  <button className="browse-btn" onClick={() => browseKeyFile('keyPath')}>Browse</button>
                </div>
              </div>
              <div className="form-group">
                <label>Passphrase (optional)</label>
                <input type="password" placeholder="Key passphrase" value={form.passphrase}
                  onChange={(e) => set('passphrase', e.target.value)} />
              </div>
            </>
          )}

          {/* Jump Host */}
          <div className="form-group">
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
              <input type="checkbox" style={{ width: 'auto' }} checked={form.useJump}
                onChange={(e) => set('useJump', e.target.checked)} />
              <Server size={13} /> Use Jump Host (ProxyJump)
            </label>
          </div>

          {form.useJump && (
            <div className="jump-host-section">
              <div className="form-row">
                <div className="form-group flex-1">
                  <label>Jump Host *</label>
                  <input type="text" placeholder="bastion.example.com" value={form.jumpHost}
                    onChange={(e) => set('jumpHost', e.target.value)} />
                </div>
                <div className="form-group" style={{ width: 80 }}>
                  <label>Port</label>
                  <input type="number" value={form.jumpPort}
                    onChange={(e) => set('jumpPort', e.target.value)} />
                </div>
              </div>
              <div className="form-group">
                <label>Jump Username *</label>
                <input type="text" placeholder="root" value={form.jumpUsername}
                  onChange={(e) => set('jumpUsername', e.target.value)} />
              </div>
              <div className="form-group">
                <label>Jump Auth</label>
                <div className="auth-toggle">
                  <button className={form.jumpAuthType === 'password' ? 'active' : ''} onClick={() => set('jumpAuthType', 'password')}>
                    <Lock size={13} /> Password
                  </button>
                  <button className={form.jumpAuthType === 'key' ? 'active' : ''} onClick={() => set('jumpAuthType', 'key')}>
                    <Key size={13} /> Key
                  </button>
                </div>
              </div>
              {form.jumpAuthType === 'password' ? (
                <div className="form-group">
                  <label>Jump Password</label>
                  <input type="password" placeholder="••••••••" value={form.jumpPassword}
                    onChange={(e) => set('jumpPassword', e.target.value)} />
                </div>
              ) : (
                <>
                  <div className="form-group">
                    <label>Jump Key File</label>
                    <div className="input-row">
                      <input type="text" placeholder="/home/user/.ssh/id_rsa" value={form.jumpKeyPath} readOnly />
                      <button className="browse-btn" onClick={() => browseKeyFile('jumpKeyPath')}>Browse</button>
                    </div>
                  </div>
                  <div className="form-group">
                    <label>Jump Passphrase (optional)</label>
                    <input type="password" placeholder="Key passphrase" value={form.jumpPassphrase}
                      onChange={(e) => set('jumpPassphrase', e.target.value)} />
                  </div>
                </>
              )}
            </div>
          )}
        </div>

        <div className="dialog-footer">
          <button className="btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn-secondary" onClick={handleSave}>Save</button>
          <button className="btn-primary" onClick={handleConnect}>Connect</button>
        </div>
      </div>
    </div>
  )
}

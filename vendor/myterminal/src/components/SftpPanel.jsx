import React, { useState, useEffect, useRef } from 'react'
import {
  Folder, File, ChevronUp, ArrowLeft, ArrowRight, RefreshCw, Upload, Download,
  FolderPlus, Trash2, Edit2, Home, Star, X, Copy, ClipboardCopy, FolderOpen,
  FileEdit, FileDown, ArrowUp as SortAsc, ArrowDown as SortDesc,
} from 'lucide-react'


function formatSize(bytes) {
  if (bytes == null) return ''
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
  if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MB'
  return (bytes / 1024 / 1024 / 1024).toFixed(2) + ' GB'
}

function formatDate(mtime) {
  if (!mtime) return ''
  return new Date(mtime * 1000).toLocaleDateString()
}

export default function SftpPanel({ channelId, cwd, width, sessionKey = 'default', onEditFile }) {
  const [path, setPath] = useState('/')
  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [selectedNames, setSelectedNames] = useState(() => new Set())
  const [anchorName, setAnchorName] = useState(null)
  const [renaming, setRenaming] = useState(null)
  const [renameValue, setRenameValue] = useState('')
  const [favorites, setFavorites] = useState([])
  const [sftpHome, setSftpHome] = useState(null)
  const [canGoBack, setCanGoBack] = useState(false)
  const [canGoForward, setCanGoForward] = useState(false)
  const [sortKey, setSortKey] = useState('name')  // 'name' | 'size' | 'mtime'
  const [sortAsc, setSortAsc] = useState(true)
  const [editingPath, setEditingPath] = useState(false)
  const [pathInput, setPathInput] = useState('')
  const [ctxMenu, setCtxMenu] = useState(null)
  const ctxMenuRef = useRef(null)
  const pathRef = useRef('/')
  const dropRef = useRef(null)
  const navHistoryRef = useRef([])
  const historyIdxRef = useRef(-1)
  const loadRequestRef = useRef(0)

  const loadDir = async (dir, cdTerminal = false, skipHistory = false) => {
    const requestId = ++loadRequestRef.current
    setLoading(true)
    setError(null)
    setSelectedNames(new Set())
    setAnchorName(null)
    const result = await window.electronAPI.sftp.list(channelId, dir)
    if (requestId !== loadRequestRef.current) return
    setLoading(false)
    if (result?.error) { setError(result.error); return }
    setItems(result)
    setPath(dir)
    pathRef.current = dir
    if (!skipHistory) {
      navHistoryRef.current = navHistoryRef.current.slice(0, historyIdxRef.current + 1)
      navHistoryRef.current.push(dir)
      historyIdxRef.current = navHistoryRef.current.length - 1
      setCanGoBack(historyIdxRef.current > 0)
      setCanGoForward(false)
    }
    if (cdTerminal) {
      // Single-quote the path so spaces and most metacharacters are safe.
      // Escape any literal single-quotes inside the path (bash: 'it'\''s' trick).
      const safeDir = dir.replace(/'/g, "'\\''")
      window.electronAPI.ssh.write(channelId, `cd '${safeDir}'\r`)
    }
  }

  const goBack = () => {
    if (historyIdxRef.current <= 0) return
    historyIdxRef.current--
    const dir = navHistoryRef.current[historyIdxRef.current]
    setCanGoBack(historyIdxRef.current > 0)
    setCanGoForward(true)
    loadDir(dir, false, true)
  }

  const goForward = () => {
    if (historyIdxRef.current >= navHistoryRef.current.length - 1) return
    historyIdxRef.current++
    const dir = navHistoryRef.current[historyIdxRef.current]
    setCanGoBack(true)
    setCanGoForward(historyIdxRef.current < navHistoryRef.current.length - 1)
    loadDir(dir, false, true)
  }

  useEffect(() => {
    loadDir('/')
    // Resolve home directory via SFTP realpath('.')
    window.electronAPI.sftp.realpath(channelId, '.').then((result) => {
      if (result && !result.error) setSftpHome(result)
    })
  }, [channelId])

  // Load favorites from electron-store (persistent, survives app restarts)
  useEffect(() => {
    window.electronAPI.favorites.get(sessionKey).then(setFavorites)
  }, [sessionKey])

  // Auto-navigate when terminal cwd changes
  useEffect(() => {
    if (!cwd) return
    // Resolve ~ to home directory
    let resolved = cwd
    if (cwd === '~') {
      resolved = sftpHome || '/'
    } else if (cwd.startsWith('~/')) {
      resolved = sftpHome ? sftpHome + cwd.slice(1) : cwd.slice(1) || '/'
    }
    if (resolved && resolved !== pathRef.current) {
      loadDir(resolved)
    }
  }, [cwd, sftpHome])

  const navigate = (item) => {
    if (item.type === 'd') {
      const newPath = path === '/' ? `/${item.name}` : `${path}/${item.name}`
      loadDir(newPath)
    } else if (item.type === 'f' && onEditFile) {
      const filePath = joinPath(path, item.name)
      onEditFile(filePath)
    }
  }

  const goUp = () => {
    if (path === '/') return
    const parent = path.substring(0, path.lastIndexOf('/')) || '/'
    loadDir(parent)
  }

  const joinPath = (p, name) => (p === '/' ? `/${name}` : `${p}/${name}`)

  // ── Favorites ──────────────────────────────────────────────────────────────

  const isFavorite = favorites.includes(path)

  const toggleFavorite = () => {
    let updated
    if (isFavorite) {
      updated = favorites.filter(f => f !== path)
    } else {
      updated = [...favorites, path]
    }
    setFavorites(updated)
    window.electronAPI.favorites.set(sessionKey, updated)
  }

  const removeFavorite = (fav, e) => {
    e.stopPropagation()
    const updated = favorites.filter(f => f !== fav)
    setFavorites(updated)
    window.electronAPI.favorites.set(sessionKey, updated)
  }

  const goToFavorite = (fav) => {
    loadDir(fav, true)  // navigate SFTP + cd in terminal
  }

  const beginEditPath = () => {
    setPathInput(path)
    setEditingPath(true)
  }

  const commitEditPath = () => {
    const target = pathInput.trim()
    setEditingPath(false)
    if (!target || target === path) return
    loadDir(target, true)  // navigate SFTP + cd in terminal
  }

  const cancelEditPath = () => {
    setEditingPath(false)
  }

  // ── File operations ────────────────────────────────────────────────────────

  const handleDownload = async () => {
    if (selectedItems.length === 0) return

    // Single file → save-as dialog. Otherwise pick a parent directory and
    // recreate each selected file/folder inside it.
    if (selectedItems.length === 1 && selectedItems[0].type !== 'd') {
      const only = selectedItems[0]
      const result = await window.electronAPI.dialog.saveFile({
        defaultPath: only.name,
        securityScope: 'sftp-download-file',
      })
      if (result.canceled) return
      const res = await window.electronAPI.sftp.download(channelId, joinPath(path, only.name), result.filePath)
      if (res?.error) setError(res.error)
      return
    }

    const pick = await window.electronAPI.dialog.openFile({
      title: selectedItems.length === 1
        ? `Download "${selectedItems[0].name}" to…`
        : `Download ${selectedItems.length} items to…`,
      properties: ['openDirectory', 'createDirectory'],
      securityScope: 'sftp-download-dir',
    })
    if (pick.canceled || !pick.filePaths?.[0]) return
    const parent = pick.filePaths[0]
    const sep = parent.includes('\\') ? '\\' : '/'
    const trimmed = parent.endsWith('\\') || parent.endsWith('/') ? parent.slice(0, -1) : parent

    setLoading(true)
    const failures = []
    for (const item of selectedItems) {
      const remotePath = joinPath(path, item.name)
      const target = trimmed + sep + item.name
      const res = item.type === 'd'
        ? await window.electronAPI.sftp.downloadDir(channelId, remotePath, target)
        : await window.electronAPI.sftp.download(channelId, remotePath, target)
      if (res?.error) failures.push(`${item.name}: ${res.error}`)
    }
    setLoading(false)
    if (failures.length) setError(failures.join('\n'))
  }

  const handleUpload = async () => {
    const result = await window.electronAPI.dialog.openFile({
      properties: ['openFile', 'multiSelections'],
      securityScope: 'sftp-upload',
    })
    if (result.canceled) return
    for (const localPath of result.filePaths) {
      const name = localPath.replace(/\\/g, '/').split('/').pop()
      const res = await window.electronAPI.sftp.upload(channelId, localPath, joinPath(path, name))
      if (res?.error) { setError(res.error); return }
    }
    loadDir(path)
  }

  const handleMkdir = async () => {
    const name = prompt('New folder name:')
    if (!name) return
    const res = await window.electronAPI.sftp.mkdir(channelId, joinPath(path, name))
    if (res?.error) { setError(res.error); return }
    loadDir(path)
  }

  const handleDelete = async () => {
    if (selectedItems.length === 0) return
    const msg = selectedItems.length === 1
      ? `Delete "${selectedItems[0].name}"?`
      : `Delete ${selectedItems.length} items?`
    if (!confirm(msg)) return
    const failures = []
    for (const item of selectedItems) {
      const res = await window.electronAPI.sftp.delete(channelId, joinPath(path, item.name))
      if (res?.error) failures.push(`${item.name}: ${res.error}`)
    }
    if (failures.length) setError(failures.join('\n'))
    setSelectedNames(new Set())
    setAnchorName(null)
    loadDir(path)
  }

  const startRename = () => {
    if (!singleSelected) return
    setRenaming(singleSelected)
    setRenameValue(singleSelected.name)
  }

  const commitRename = async () => {
    if (!renaming || !renameValue || renameValue === renaming.name) { setRenaming(null); return }
    const res = await window.electronAPI.sftp.rename(channelId, joinPath(path, renaming.name), joinPath(path, renameValue))
    if (res?.error) setError(res.error)
    setRenaming(null)
    loadDir(path)
  }

  const handleDrop = async (e) => {
    e.preventDefault()
    // The preload capture-phase listener has already resolved the native file
    // paths via webUtils.getPathForFile and stashed them.  Retrieve them now.
    const localPaths = window.electronAPI.getDropPaths()
    if (!localPaths.length) return
    const errors = []
    for (const localPath of localPaths) {
      if (!localPath) continue
      const name = localPath.replace(/\\/g, '/').split('/').pop()
      const isDir = await window.electronAPI.fs.isDirectory(localPath)
      const remoteDest = joinPath(path, name)
      const res = isDir
        ? await window.electronAPI.sftp.uploadDir(channelId, localPath, remoteDest)
        : await window.electronAPI.sftp.upload(channelId, localPath, remoteDest)
      if (res?.error) errors.push(`${name}: ${res.error}`)
    }
    if (errors.length) setError(errors.join('\n'))
    loadDir(path)
  }

  // ── Sorting ─────────────────────────────────────────────────────────────────

  const toggleSort = (key) => {
    if (sortKey === key) setSortAsc(!sortAsc)
    else { setSortKey(key); setSortAsc(true) }
  }

  const sortedItems = [...items].sort((a, b) => {
    // Folders always before files
    if (a.type !== b.type) return a.type === 'd' ? -1 : 1
    let cmp = 0
    if (sortKey === 'name') cmp = a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
    else if (sortKey === 'size') cmp = (a.size || 0) - (b.size || 0)
    else if (sortKey === 'mtime') cmp = (a.mtime || 0) - (b.mtime || 0)
    return sortAsc ? cmp : -cmp
  })

  const SortIcon = ({ col }) => {
    if (sortKey !== col) return null
    return sortAsc ? <SortAsc size={11} /> : <SortDesc size={11} />
  }

  // ── Selection ───────────────────────────────────────────────────────────────

  const selectedItems = sortedItems.filter((i) => selectedNames.has(i.name))
  const singleSelected = selectedItems.length === 1 ? selectedItems[0] : null

  const handleItemClick = (item, e) => {
    if (e.ctrlKey || e.metaKey) {
      setSelectedNames((prev) => {
        const next = new Set(prev)
        if (next.has(item.name)) next.delete(item.name)
        else next.add(item.name)
        return next
      })
      setAnchorName(item.name)
    } else if (e.shiftKey && anchorName) {
      const aIdx = sortedItems.findIndex((i) => i.name === anchorName)
      const bIdx = sortedItems.findIndex((i) => i.name === item.name)
      if (aIdx >= 0 && bIdx >= 0) {
        const [lo, hi] = aIdx < bIdx ? [aIdx, bIdx] : [bIdx, aIdx]
        setSelectedNames(new Set(sortedItems.slice(lo, hi + 1).map((i) => i.name)))
      } else {
        setSelectedNames(new Set([item.name]))
        setAnchorName(item.name)
      }
    } else {
      setSelectedNames(new Set([item.name]))
      setAnchorName(item.name)
    }
  }

  // ── Context menu ────────────────────────────────────────────────────────────

  const handleContextMenu = (e, item) => {
    e.preventDefault()
    e.stopPropagation()
    // If the right-clicked item isn't already in the selection, replace the
    // selection with just that item — standard file-manager behavior.
    if (!selectedNames.has(item.name)) {
      setSelectedNames(new Set([item.name]))
      setAnchorName(item.name)
    }
    const x = Math.min(e.clientX, window.innerWidth - 200)
    const y = Math.min(e.clientY, window.innerHeight - 300)
    setCtxMenu({ x, y, item })
  }

  const handleBgContextMenu = (e) => {
    e.preventDefault()
    const x = Math.min(e.clientX, window.innerWidth - 200)
    const y = Math.min(e.clientY, window.innerHeight - 300)
    setCtxMenu({ x, y, item: null })
  }

  const closeCtxMenu = () => setCtxMenu(null)

  useEffect(() => {
    if (!ctxMenu) return
    const onClickOutside = (e) => {
      if (ctxMenuRef.current && !ctxMenuRef.current.contains(e.target)) closeCtxMenu()
    }
    document.addEventListener('mousedown', onClickOutside)
    return () => document.removeEventListener('mousedown', onClickOutside)
  }, [ctxMenu])

  const ctxCopyPath = () => {
    if (!ctxMenu?.item) return
    const fullPath = joinPath(path, ctxMenu.item.name)
    window.electronAPI.clipboard.writeText(fullPath)
    closeCtxMenu()
  }

  const ctxCopyName = () => {
    if (!ctxMenu?.item) return
    window.electronAPI.clipboard.writeText(ctxMenu.item.name)
    closeCtxMenu()
  }

  const ctxOpen = () => {
    if (!ctxMenu?.item) return
    navigate(ctxMenu.item)
    closeCtxMenu()
  }

  const ctxDownload = async () => {
    // handleContextMenu already normalized the selection to either "all
    // previously-selected" (if the right-click hit one of them) or "just the
    // right-clicked item" — so the toolbar handler does the right thing for
    // both single- and multi-item downloads.
    closeCtxMenu()
    await handleDownload()
  }

  const ctxRename = () => {
    if (!ctxMenu?.item) return
    setSelectedNames(new Set([ctxMenu.item.name]))
    setAnchorName(ctxMenu.item.name)
    setRenaming(ctxMenu.item)
    setRenameValue(ctxMenu.item.name)
    closeCtxMenu()
  }

  const ctxDelete = async () => {
    // Same routing as ctxDownload: handleContextMenu has already normalized
    // the selection, so deleting through the toolbar handler keeps single- and
    // multi-item behavior in lockstep with the rest of the panel.
    closeCtxMenu()
    await handleDelete()
  }

  const ctxNewFolder = async () => {
    closeCtxMenu()
    handleMkdir()
  }

  const ctxUpload = async () => {
    closeCtxMenu()
    handleUpload()
  }

  const ctxRefresh = () => {
    closeCtxMenu()
    loadDir(path)
  }

  const ctxCopyDirPath = () => {
    window.electronAPI.clipboard.writeText(path)
    closeCtxMenu()
  }

  return (
    <div className="sftp-panel" ref={dropRef} onDrop={handleDrop} onDragOver={e => e.preventDefault()}
      style={width ? { width } : undefined}>
      {/* Toolbar */}
      <div className="sftp-toolbar">
        <button className="icon-btn" onClick={goBack} title="Back" disabled={!canGoBack}><ArrowLeft size={15} /></button>
        <button className="icon-btn" onClick={goForward} title="Forward" disabled={!canGoForward}><ArrowRight size={15} /></button>
        <button className="icon-btn" onClick={goUp} title="Up" disabled={path === '/'}><ChevronUp size={15} /></button>
        <button className="icon-btn" onClick={() => loadDir(sftpHome || '/')} title="Home"><Home size={15} /></button>
        <button
          className={`icon-btn ${isFavorite ? 'active' : ''}`}
          onClick={toggleFavorite}
          title={isFavorite ? 'Remove from favorites' : 'Add to favorites'}
        >
          <Star size={15} fill={isFavorite ? 'currentColor' : 'none'} />
        </button>
        <button className="icon-btn" onClick={() => loadDir(path)} title="Refresh"><RefreshCw size={15} /></button>
        <button className="icon-btn" onClick={handleUpload} title="Upload"><Upload size={15} /></button>
        <button className="icon-btn" onClick={handleDownload} title="Download" disabled={selectedItems.length === 0}><Download size={15} /></button>
        <button className="icon-btn" onClick={handleMkdir} title="New folder"><FolderPlus size={15} /></button>
        <button className="icon-btn" onClick={startRename} title="Rename" disabled={!singleSelected}><Edit2 size={15} /></button>
        <button className="icon-btn danger" onClick={handleDelete} title="Delete" disabled={selectedItems.length === 0}><Trash2 size={15} /></button>
      </div>

      {/* Address bar — breadcrumb crumbs / editor */}
      <div className="sftp-address-bar">
        {editingPath ? (
          <input
            type="text"
            className="sftp-path-input"
            value={pathInput}
            autoFocus
            onChange={(e) => setPathInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitEditPath()
              else if (e.key === 'Escape') cancelEditPath()
            }}
            onBlur={cancelEditPath}
            spellCheck={false}
          />
        ) : (
          <div
            className="sftp-breadcrumbs"
            onClick={beginEditPath}
            title="Click empty area to type a path"
          >
            <button
              type="button"
              className="crumb"
              onClick={(e) => { e.stopPropagation(); loadDir('/', true) }}
              title="Go to /"
            >/</button>
            {(() => {
              const segs = path.split('/').filter(Boolean)
              let cum = ''
              return segs.map((seg, i) => {
                cum += '/' + seg
                const target = cum
                return (
                  <React.Fragment key={i}>
                    <span className="crumb-sep">/</span>
                    <button
                      type="button"
                      className="crumb"
                      onClick={(e) => { e.stopPropagation(); loadDir(target, true) }}
                      title={`Go to ${target}`}
                    >{seg}</button>
                  </React.Fragment>
                )
              })
            })()}
            <span className="crumb-tail" />
          </div>
        )}
      </div>

      {/* Favorites bar */}
      {favorites.length > 0 && (
        <div className="sftp-favorites">
          {favorites.map(fav => (
            <button
              key={fav}
              className={`fav-chip ${fav === path ? 'active' : ''}`}
              onClick={() => goToFavorite(fav)}
              title={`Go to ${fav} and cd in terminal`}
            >
              <Star size={10} fill="currentColor" />
              <span>{fav}</span>
              <span className="fav-remove" onClick={e => removeFavorite(fav, e)}><X size={9} /></span>
            </button>
          ))}
        </div>
      )}

      {error && <div className="sftp-error">{error}</div>}

      {loading ? (
        <div className="sftp-loading">Loading...</div>
      ) : (
        <div className="sftp-list" onContextMenu={handleBgContextMenu}>
          <table>
            <thead>
              <tr>
                <th className="sortable" onClick={() => toggleSort('name')}>Name <SortIcon col="name" /></th>
                <th className="sortable" onClick={() => toggleSort('size')}>Size <SortIcon col="size" /></th>
                <th className="sortable" onClick={() => toggleSort('mtime')}>Modified <SortIcon col="mtime" /></th>
              </tr>
            </thead>
            <tbody>
              {path !== '/' && (
                <tr onClick={goUp}>
                  <td colSpan={3}>
                    <span className="sftp-file-icon"><Folder size={13} /></span>
                    ..
                  </td>
                </tr>
              )}
              {sortedItems.map(item => (
                <tr
                  key={item.name}
                  className={selectedNames.has(item.name) ? 'selected' : ''}
                  onClick={(e) => handleItemClick(item, e)}
                  onDoubleClick={() => navigate(item)}
                  onContextMenu={(e) => handleContextMenu(e, item)}
                >
                  <td>
                    <span className="sftp-file-icon">
                      {item.type === 'd' ? <Folder size={13} /> : <File size={13} />}
                    </span>
                    {renaming?.name === item.name ? (
                      <input
                        autoFocus
                        value={renameValue}
                        onChange={e => setRenameValue(e.target.value)}
                        onBlur={commitRename}
                        onKeyDown={e => { if (e.key === 'Enter') commitRename(); if (e.key === 'Escape') setRenaming(null) }}
                        onClick={e => e.stopPropagation()}
                      />
                    ) : item.name}
                  </td>
                  <td>{item.type === 'd' ? '' : formatSize(item.size)}</td>
                  <td>{formatDate(item.mtime)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Context menu */}
      {ctxMenu && (
        <div ref={ctxMenuRef} className="context-menu" style={{ top: ctxMenu.y, left: ctxMenu.x }}>
          {ctxMenu.item ? (
            <>
              <button onClick={ctxOpen}>
                {ctxMenu.item.type === 'd' ? <FolderOpen size={14} /> : <FileEdit size={14} />}
                {ctxMenu.item.type === 'd' ? 'Open' : 'Edit'}
              </button>
              <button onClick={ctxDownload}><FileDown size={14} /> Download</button>
              <div className="context-menu-sep" />
              <button onClick={ctxCopyPath}><ClipboardCopy size={14} /> Copy Path</button>
              <button onClick={ctxCopyName}><Copy size={14} /> Copy Name</button>
              <div className="context-menu-sep" />
              <button onClick={ctxRename}><Edit2 size={14} /> Rename</button>
              <button className="danger" onClick={ctxDelete}><Trash2 size={14} /> Delete</button>
            </>
          ) : (
            <>
              <button onClick={ctxCopyDirPath}><ClipboardCopy size={14} /> Copy Directory Path</button>
              <div className="context-menu-sep" />
              <button onClick={ctxNewFolder}><FolderPlus size={14} /> New Folder</button>
              <button onClick={ctxUpload}><Upload size={14} /> Upload</button>
              <button onClick={ctxRefresh}><RefreshCw size={14} /> Refresh</button>
            </>
          )}
        </div>
      )}
    </div>
  )
}

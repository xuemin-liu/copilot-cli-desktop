import React, { useState, useRef, useEffect } from 'react'
import { Sparkles, Send, Play, X, Settings, Copy, Terminal, ScrollText } from 'lucide-react'

export default function AiBar({ onRun, onClose, getSelection, getRecentOutput, osHint, inputRef: externalInputRef }) {
  const [query, setQuery] = useState('')
  const [result, setResult] = useState(null)   // { type: 'command'|'text', value: string }
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [keyStatus, setKeyStatus] = useState(null)
  const [showKeyInput, setShowKeyInput] = useState(false)
  const [keyInput, setKeyInput] = useState('')
  const [context, setContext] = useState('')
  const [contextSource, setContextSource] = useState(null) // 'selection' | 'output'
  const localInputRef = useRef(null)
  const inputRef = externalInputRef || localInputRef
  const commandRef = useRef(null)

  useEffect(() => {
    inputRef.current?.focus()
    window.electronAPI.ai.getKeyStatus().then(setKeyStatus)
    // Capture any current terminal selection
    const sel = getSelection?.() || ''
    if (sel) { setContext(sel); setContextSource('selection') }
  }, [])

  const captureOutput = () => {
    const output = getRecentOutput?.() || ''
    if (output) { setContext(output); setContextSource('output') }
  }

  const clearContext = () => { setContext(''); setContextSource(null) }

  const submit = async (q = query) => {
    if (!q.trim()) return
    setLoading(true)
    setError(null)
    setResult(null)
    const result = await window.electronAPI.ai.complete({
      query: q.trim(),
      context: context || undefined,
      os: osHint || 'Linux',
    })
    setLoading(false)
    if (result.error === 'NO_KEY') { setShowKeyInput(true); return }
    if (result.error) { setError(result.error); return }
    setResult(result)
  }

  const handleSaveKey = async () => {
    if (!keyInput.trim()) return
    await window.electronAPI.ai.setKey(keyInput.trim())
    const status = await window.electronAPI.ai.getKeyStatus()
    setKeyStatus(status)
    setShowKeyInput(false)
    setKeyInput('')
    if (query.trim()) submit()
  }

  const handleRun = () => {
    const cmd = commandRef.current?.textContent || result?.value || ''
    if (cmd) { onRun(cmd + '\r'); onClose() }
  }

  const currentCommand = result?.type === 'command' ? result.value : ''

  return (
    <div className="ai-bar">
      {/* Header */}
      <div className="ai-bar-header">
        <span className="ai-bar-title"><Sparkles size={13} /> AI Assistant</span>
        <div className="ai-bar-header-right">
          {keyStatus && <span className="ai-key-status">Key: {keyStatus}</span>}
          <button className="icon-btn" onClick={() => setShowKeyInput(v => !v)} title="Set API key">
            <Settings size={14} />
          </button>
          <button className="icon-btn" onClick={onClose} title="Close (Esc)">
            <X size={14} />
          </button>
        </div>
      </div>

      {/* API key input */}
      {showKeyInput && (
        <div className="ai-key-row">
          <input
            type="password"
            placeholder="Paste Anthropic API key (sk-ant-...)"
            value={keyInput}
            onChange={e => setKeyInput(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleSaveKey()}
            autoFocus
          />
          <button className="btn-primary" onClick={handleSaveKey}>Save</button>
        </div>
      )}

      {/* Context badge */}
      {context && (
        <div className="ai-context-badge">
          {contextSource === 'output' ? <ScrollText size={11} /> : <Terminal size={11} />}
          <span>
            {contextSource === 'output'
              ? `Last ${context.split('\n').length} lines captured as context`
              : `${context.length} chars selected as context`}
          </span>
          <button className="icon-btn" style={{ width: 18, height: 18 }} onClick={clearContext}>
            <X size={10} />
          </button>
        </div>
      )}

      {/* Query input */}
      <form className="ai-bar-input-row" onSubmit={e => { e.preventDefault(); submit() }}>
        <input
          ref={inputRef}
          type="text"
          className="ai-query-input"
          placeholder={context
            ? 'Ask about the context — "summarize", "explain this error", "what went wrong?"'
            : '"kill process nginx", "show disk usage", "what does SIGTERM mean?"'}
          value={query}
          onChange={e => setQuery(e.target.value)}
          disabled={loading}
        />
        <button
          type="button"
          className={`icon-btn ${contextSource === 'output' ? 'active' : ''}`}
          onClick={captureOutput}
          title="Capture last 150 lines of terminal output as context"
        >
          <ScrollText size={14} />
        </button>
        <button className="btn-primary ai-send-btn" type="submit" disabled={loading || !query.trim()}>
          {loading ? <span className="ai-spinner" /> : <Send size={14} />}
        </button>
      </form>

      {error && <div className="ai-error">{error}</div>}

      {/* Command result */}
      {result?.type === 'command' && (
        <div className="ai-result">
          <code
            ref={commandRef}
            className="ai-command"
            contentEditable
            suppressContentEditableWarning
            spellCheck={false}
          >
            {currentCommand}
          </code>
          <div className="ai-result-actions">
            <button className="icon-btn" onClick={() => navigator.clipboard.writeText(commandRef.current?.textContent || currentCommand)} title="Copy">
              <Copy size={14} />
            </button>
            <button className="btn-primary ai-run-btn" onClick={handleRun}>
              <Play size={13} /> Run
            </button>
          </div>
        </div>
      )}

      {/* Text / explanation result */}
      {result?.type === 'text' && (
        <div className="ai-text-result">
          <div className="ai-text-content">{result.value}</div>
          <button className="icon-btn ai-copy-text" onClick={() => navigator.clipboard.writeText(result.value)} title="Copy">
            <Copy size={13} />
          </button>
        </div>
      )}
    </div>
  )
}

import { useEffect, useRef, useState } from 'react'
import type { JSX } from 'react'
import type { AttentionItem } from '../../main/workflow-attention.js'

export function NeedsYou({ items, compact, onExpand, onActivate }: {
  items: readonly AttentionItem[]; compact: boolean; onExpand(): void; onActivate(tabId: string): void
}): JSX.Element | null {
  const [open, setOpen] = useState(true)
  const [seen, setSeen] = useState<Set<string>>(() => {
    try {
      const value: unknown = JSON.parse(localStorage.getItem('workflow-attention-seen') ?? '[]')
      return new Set(Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string').slice(-200) : [])
    } catch { return new Set() }
  })
  const previous = useRef(new Set<string>())
  useEffect(() => {
    const current = new Set(items.map(item => item.key))
    const removed = [...previous.current].filter(key => !current.has(key))
    previous.current = current
    if (!removed.length) return
    setSeen(value => {
      const next = new Set(value)
      for (const key of removed) next.delete(key)
      try { localStorage.setItem('workflow-attention-seen', JSON.stringify([...next])) } catch { /* memory-only */ }
      return next
    })
  }, [items])
  if (!items.length) return null
  const unread = items.filter(item => !seen.has(item.key)).length
  const activate = (item: AttentionItem): void => {
    const next = new Set([...seen, item.key].slice(-200))
    setSeen(next)
    try { localStorage.setItem('workflow-attention-seen', JSON.stringify([...next])) } catch { /* keep the in-memory acknowledgment */ }
    onActivate(item.tabId)
  }
  if (compact) return <button type="button" className="icon-button" title={`Needs you: ${items.length}`} aria-label={`Needs you: ${items.length}`} onClick={() => { setOpen(true); onExpand() }}>!</button>
  return <section className="needs-you" aria-label="Needs you">
    <button type="button" className="needs-you-heading" aria-expanded={open} onClick={() => setOpen(!open)}>Needs you · {items.length}{unread ? ` · ${unread} new` : ''}</button>
    {open && <ul>{items.map(item => <li key={item.key}><button type="button" onClick={() => activate(item)}><strong>{item.title}</strong><span>{item.reasons.join(' · ')}</span></button></li>)}</ul>}
  </section>
}

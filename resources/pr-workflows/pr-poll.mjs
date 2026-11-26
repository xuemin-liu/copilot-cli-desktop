#!/usr/bin/env node
// Forge-agnostic check for new/edited review feedback, revision moves (head and base), and verified current-(head, base) approvals
// across GitHub, self-hosted Gitea/Forgejo, and GitLab.
//
//   node pr-poll.mjs <pr-or-url> <state-file> [--repo OWNER/REPO] [--pr-url URL] [--origin URL] [--forge github|gitea|gitlab]
//                                             [--allow-http-origin ORIGIN] [--marker "<prefix>"] [--invert] [--watch-head]
//                                             [--allow-approver LOGIN]... [--require-tag "[CLI]"]... [--snapshot]
//   node pr-poll.mjs <pr-or-url> <state-file> ... --init
//   node pr-poll.mjs <pr-or-url> <state-file> ... --mark --through <reviewId>,<inlineId>,<issueId> --head <sha> [--base <sha>] [--snapshot-id <id>]
//   node pr-poll.mjs <pr-or-url> <state-file> ... --wait [seconds] [--max <seconds>]
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import {
  evaluateRevisionApprovals,
  fetchForgePullSnapshot,
  resolveForgeEndpoint,
  SHA_RE,
} from './pr-forge.mjs'

const argv = process.argv.slice(2)

const VALUE_OPTIONS = new Set([
  '--repo',
  '--pr-url',
  '--origin',
  '--forge',
  '--allow-http-origin',
  '--marker',
  '--through',
  '--head',
  '--base',
  '--snapshot-id',
  '--max',
  '--allow-approver',
  '--require-tag',
])

const flag = (name) => argv.includes(name)
const option = (name) => {
  const index = argv.indexOf(name)
  return index >= 0 ? argv[index + 1] : undefined
}
const multiOption = (name) => {
  const values = []
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === name && argv[i + 1] !== undefined) values.push(argv[i + 1])
  }
  return values
}

async function evaluateOnce({ prArg, stateFile }) {
  const marker = option('--marker') ?? '\u{1F916} '
  const endpoint = resolveForgeEndpoint({
    prInput: prArg,
    repoOption: option('--repo'),
    prUrlOption: option('--pr-url'),
    originOption: option('--origin'),
    forgeOption: option('--forge'),
    allowHttpOriginOption: option('--allow-http-origin'),
  })

  const snapshot = await fetchForgePullSnapshot(endpoint, { includeActor: true })
  const { meta, reviews, inline, issue } = snapshot

  const localChecksAllowed = flag('--snapshot')
    && Boolean(meta.sameRepo)
    && meta.authorId !== null
    && meta.actorId !== null
    && String(meta.authorId) === String(meta.actorId)

  const state = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8').replace(/^\uFEFF/, '')) : {}
  const top = (items) => items.reduce((highest, item) => Math.max(highest, Number(item.id) || 0), 0)
  const now = {
    maxReviewId: top(reviews),
    maxInlineId: top(inline),
    maxIssueId: top(issue),
    headSha: meta.headRefOid,
    baseSha: meta.baseRefOid,
  }

  const writeStateAtomically = (doc) => {
    const temporary = `${stateFile}.${randomUUID()}.tmp`
    try {
      writeFileSync(temporary, JSON.stringify(doc), { flag: 'wx', mode: 0o600 })
      renameSync(temporary, stateFile)
    } finally {
      rmSync(temporary, { force: true })
    }
  }

  const buildVersionMap = (items, maxId, prevMap = {}, deliveredMap = null) => {
    const nextMap = { ...prevMap }
    for (const item of items) {
      if (maxId === null || item.id <= maxId) {
        const key = String(item.id)
        if (deliveredMap !== null) {
          if (Object.hasOwn(deliveredMap, key)) {
            nextMap[key] = deliveredMap[key]
          } else if (!Object.hasOwn(nextMap, key)) {
            // Item ID <= watermark was NOT present in the acknowledged snapshot; store an empty sentinel instead of
            // stamping the live version so a subsequent poll still wakes and delivers this unseen/edited item.
            nextMap[key] = ''
          }
        } else if (!Object.hasOwn(nextMap, key)) {
          nextMap[key] = item.versionKey
        }
      }
    }
    return nextMap
  }

  const buildLiveVersionMap = (items) => {
    const map = {}
    for (const item of items) {
      map[String(item.id)] = item.versionKey
    }
    return map
  }

  if (flag('--init') || flag('--mark')) {
    const keys = ['maxReviewId', 'maxInlineId', 'maxIssueId']
    const through = option('--through')?.split(',').map(Number)
    if (flag('--mark') && (!through || through.length !== 3 || through.some((value) => !Number.isSafeInteger(value) || value < 0))) {
      const err = new Error('--through takes <reviewId>,<inlineId>,<issueId>')
      err.exitCode = 2
      throw err
    }
    const headOpt = option('--head')
    if (flag('--mark') && !SHA_RE.test(headOpt ?? '')) {
      const err = new Error('--mark requires the full assessed commit SHA in --head')
      err.exitCode = 2
      throw err
    }
    const baseOpt = option('--base')
    if (baseOpt !== undefined && !SHA_RE.test(baseOpt)) {
      const err = new Error('--base must be a full 40..64-character commit SHA')
      err.exitCode = 2
      throw err
    }
    const target = Object.fromEntries(keys.map((key, index) => [key, through?.[index] ?? now[key]]))
    const next = { ...state }
    for (const key of keys) next[key] = flag('--mark') ? Math.max(state[key] ?? 0, target[key]) : now[key]
    const nextHeadSha = (headOpt ?? now.headSha).toLowerCase()
    const nextBaseSha = (baseOpt ?? now.baseSha).toLowerCase()
    if (flag('--init') || state.headSha === undefined || state.headSha !== nextHeadSha) {
      next.initialBaseForHead = nextBaseSha
      next.baseMovedForHead = false
    } else {
      const initialBase = state.initialBaseForHead ?? state.baseSha ?? nextBaseSha
      next.initialBaseForHead = initialBase
      next.baseMovedForHead = Boolean(state.baseMovedForHead || initialBase !== nextBaseSha)
    }
    next.headSha = nextHeadSha
    next.baseSha = nextBaseSha
    const prevVersions = typeof state.versions === 'object' && state.versions !== null ? state.versions : {}
    const pendingSnapshots = Array.isArray(state.pendingSnapshots)
      ? state.pendingSnapshots.filter((entry) => entry && typeof entry.id === 'string' && typeof entry.versions === 'object' && entry.versions !== null)
      : []
    const requestedSnapshotId = option('--snapshot-id')
    let deliveredVersions = null
    let remainingSnapshots = pendingSnapshots
    if (flag('--mark')) {
      if (requestedSnapshotId !== undefined) {
        const idx = pendingSnapshots.findIndex((entry) => entry.id === requestedSnapshotId)
        if (idx < 0) {
          const err = new Error(`Unknown --snapshot-id "${requestedSnapshotId}"`)
          err.exitCode = 2
          throw err
        }
        deliveredVersions = pendingSnapshots[idx].versions
        remainingSnapshots = pendingSnapshots.slice(idx + 1)
      } else if (pendingSnapshots.length > 0) {
        deliveredVersions = pendingSnapshots[0].versions
        remainingSnapshots = pendingSnapshots.slice(1)
      }
    }
    next.versions = flag('--init')
      ? {
          reviews: buildLiveVersionMap(reviews),
          inline: buildLiveVersionMap(inline),
          issue: buildLiveVersionMap(issue),
        }
      : {
          reviews: buildVersionMap(reviews, next.maxReviewId, prevVersions.reviews, deliveredVersions?.reviews ?? null),
          inline: buildVersionMap(inline, next.maxInlineId, prevVersions.inline, deliveredVersions?.inline ?? null),
          issue: buildVersionMap(issue, next.maxIssueId, prevVersions.issue, deliveredVersions?.issue ?? null),
        }
    if (flag('--init') || remainingSnapshots.length === 0) {
      delete next.pendingSnapshots
    } else {
      next.pendingSnapshots = remainingSnapshots
    }
    delete next.lastDeliveredVersions
    writeStateAtomically(next)
    return JSON.stringify({
      recorded: {
        maxReviewId: next.maxReviewId,
        maxInlineId: next.maxInlineId,
        maxIssueId: next.maxIssueId,
        headSha: next.headSha,
        baseSha: next.baseSha,
      },
    })
  }

  const marked = (item) => (item.body ?? '').startsWith(marker)
  const own = flag('--invert') ? (item) => !marked(item) : marked
  const CLIP = 8000

  const freshOrEdited = (items, kindKey, maxKey) => {
    const knownVersions = state.versions?.[kindKey] ?? null
    const watermark = state[maxKey] ?? 0
    const result = []
    for (const item of items) {
      if (own(item)) continue
      if (item.id > watermark) {
        result.push({ ...item, edited: false })
        continue
      }
      if (knownVersions && Object.hasOwn(knownVersions, String(item.id)) && knownVersions[String(item.id)] !== item.versionKey) {
        result.push({ ...item, edited: true })
      }
    }
    return result
  }

  const newReviews = freshOrEdited(reviews, 'reviews', 'maxReviewId').filter(
    (item) => !(item.state === 'COMMENTED' && (item.body ?? '').trim() === ''),
  )
  const newInline = freshOrEdited(inline, 'inline', 'maxInlineId')
  const newIssue = freshOrEdited(issue, 'issue', 'maxIssueId')

  const headChanged = state.headSha !== undefined && state.headSha !== meta.headRefOid
  const baseChanged = state.baseSha !== undefined && state.baseSha !== meta.baseRefOid
  const baseMovedForCurrentHead = Boolean(
    baseChanged
    || (!headChanged && state.headSha === meta.headRefOid && (state.baseMovedForHead || (state.initialBaseForHead && state.initialBaseForHead !== meta.baseRefOid))),
  )
  const open = meta.state === 'OPEN'
  const revisionWake = baseChanged || (flag('--watch-head') && headChanged)

  if (!flag('--snapshot') && open && newReviews.length === 0 && newInline.length === 0 && newIssue.length === 0 && !revisionWake) {
    return 'NO_CHANGE'
  }

  const authorMode = !flag('--invert')
  const requiredTags = multiOption('--require-tag')
  const allowedApprovers = multiOption('--allow-approver')

  // Compute current-(head, base) approval from the FULL paginated PR evidence (latest versions), never just `new*` above the watermark!
  const fullApproval = authorMode
    ? evaluateRevisionApprovals({
        reviews,
        inline,
        issue,
        headSha: meta.headRefOid,
        baseSha: meta.baseRefOid,
        baseChangedSinceWatermark: baseMovedForCurrentHead,
        allowedApproverLogins: allowedApprovers,
        actorId: meta.actorId,
        actorLogin: meta.actorLogin,
        requiredTags,
        marker,
      })
    : { approvalForHead: false, approvedTags: [], missingTags: requiredTags, approvingItems: [] }

  // Assign a unique identity to each delivered snapshot and append its version hashes so overlapping snapshots
  // cannot overwrite the observation that a caller is still handling before calling --mark [--snapshot-id <id>].
  const snapshotId = randomUUID()
  const deliveredEntry = {
    id: snapshotId,
    versions: {
      reviews: buildLiveVersionMap(reviews),
      inline: buildLiveVersionMap(inline),
      issue: buildLiveVersionMap(issue),
    },
  }
  const existingPending = Array.isArray(state.pendingSnapshots)
    ? state.pendingSnapshots.filter((entry) => entry && typeof entry.id === 'string' && typeof entry.versions === 'object' && entry.versions !== null)
    : []
  const nextPending = [...existingPending, deliveredEntry].slice(-32)
  try {
    writeStateAtomically({
      ...state,
      pendingSnapshots: nextPending,
    })
  } catch {
    // Ignore if stateFile's directory is read-only during a standalone --snapshot.
  }

  const approvingHintItem = (item) =>
    item.state === 'APPROVED' || /^Approved at [0-9a-f]{40,64}\b/im.test(item.body ?? '')
  const approvalHint = authorMode && (fullApproval.approvalForHead || [...newReviews, ...newInline, ...newIssue].some(approvingHintItem))
  const approvedReview = authorMode && fullApproval.approvingItems.some((item) => item.kind === 'review' && item.formal)

  const shape = ({ versionKey: _vk, userId: _uid, ...item }) =>
    (item.body ?? '').length > CLIP
      ? {
          ...item,
          body: `${item.body.slice(0, CLIP)}\n[cut at ${CLIP} characters: read the full text before deciding]`,
          truncated: true,
          length: item.body.length,
        }
      : { ...item, body: item.body ?? '' }

  return JSON.stringify(
    {
      snapshotId,
      ...(flag('--snapshot') ? { localChecksAllowed } : {}),
      forge: snapshot.forge,
      prState: meta.state,
      headSha: meta.headRefOid,
      previousHead: state.headSha ?? null,
      headChanged,
      baseRef: meta.baseRefName,
      baseSha: meta.baseRefOid,
      ...(meta.mergeBaseOid ? { mergeBaseSha: meta.mergeBaseOid } : {}),
      previousBase: state.baseSha ?? null,
      baseChanged,
      edited: [...newReviews, ...newInline, ...newIssue].some((item) => item.edited === true),
      approvedReview,
      approvalHint,
      approvalForHead: fullApproval.approvalForHead,
      ...(requiredTags.length > 0 ? { approvedTags: fullApproval.approvedTags, missingTags: fullApproval.missingTags } : {}),
      newReviews: newReviews.map(shape),
      newInline: newInline.map(shape),
      newIssue: newIssue.map(shape),
      highest: now,
    },
    null,
    2,
  )
}

async function main() {
  if (argv[0] === '--guide') {
    const role = argv[1]
    if (argv.length !== 2 || !['review-pr', 'fix-pr', 'review-and-fix-pr'].includes(role)) {
      console.error('usage: pr-poll.mjs --guide review-pr|fix-pr|review-and-fix-pr')
      process.exitCode = 2
      return
    }
    const guide = new URL('./skills/' + role + '/SKILL.md', import.meta.url)
    writeFileSync(1, readFileSync(guide))
    return
  }

  const positional = argv.filter((value, index) => {
    if (value.startsWith('--')) return false
    const prev = argv[index - 1]
    if (prev && VALUE_OPTIONS.has(prev)) return false
    if (prev === '--wait' && /^\d+$/.test(value)) return false
    return true
  })

  const [prArg, stateFile] = positional
  if (!prArg || !stateFile) {
    console.error('usage: node pr-poll.mjs <pr-or-url> <state-file> [--repo OWNER/REPO] [--marker "<prefix>"] [--init | --mark --through r,i,c --head <sha>]')
    process.exitCode = 2
    return
  }

  if (flag('--wait')) {
    const numberAfter = (name) => {
      const idx = argv.indexOf(name)
      const value = idx >= 0 ? argv[idx + 1] ?? '' : ''
      return /^\d+$/.test(value) ? Number(value) : null
    }
    const seconds = numberAfter('--wait') ?? 60
    const maxSeconds = numberAfter('--max') ?? 0
    const started = Date.now()
    let failures = 0
    for (;;) {
      let output = ''
      try {
        output = (await evaluateOnce({ prArg, stateFile })).trim()
        failures = 0
      } catch (error) {
        if (++failures >= 5) {
          throw error
        }
      }
      if (output !== '' && output !== 'NO_CHANGE') {
        console.log(output)
        return
      }
      if (maxSeconds > 0 && Date.now() - started + seconds * 1000 > maxSeconds * 1000) {
        console.log('WAIT_TIMEOUT')
        return
      }
      await new Promise((resolve) => setTimeout(resolve, seconds * 1000))
    }
  }

  const out = await evaluateOnce({ prArg, stateFile })
  console.log(out)
}

main().catch((error) => {
  const msg = String(error?.stderr || error?.message || error).trim().split('\n')[0].trim()
  console.error(msg.startsWith('ERROR: ') ? msg : `ERROR: ${msg}`)
  process.exitCode = typeof error?.exitCode === 'number' ? error.exitCode : 1
})

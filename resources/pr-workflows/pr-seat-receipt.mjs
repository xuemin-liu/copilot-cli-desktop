#!/usr/bin/env node
// Seat-scoped completion receipt helper for hidden temporary PR reviewers.
// Registers remote review/comment ID(s) with Copilot CLI Desktop so Desktop can verify them on the PR host.
//
//   node pr-seat-receipt.mjs --kind <approved|findings> --id <remote-id> [--kind-type <review|inline|issue>]
import { readFileSync } from 'node:fs'
import { request } from 'node:http'

async function main() {
  const argv = process.argv.slice(2)
  const opt = (name) => {
    const idx = argv.indexOf(name)
    return idx >= 0 ? argv[idx + 1] : undefined
  }

  const configPath = opt('--config') || process.env.COPILOT_DESKTOP_SEAT_RECEIPT
  if (!configPath) {
    console.error('COPILOT_DESKTOP_SEAT_RECEIPT is not set.')
    process.exitCode = 1
    return
  }

  const kind = opt('--kind')
  const remoteId = opt('--id')
  const itemType = opt('--kind-type') || 'any'
  if ((kind !== 'approved' && kind !== 'findings') || !remoteId || !/^[1-9]\d{0,18}$/.test(remoteId)) {
    console.error('Usage: node pr-seat-receipt.mjs --kind <approved|findings> --id <numeric-remote-id> [--kind-type review|inline|issue]')
    process.exitCode = 2
    return
  }

  const cfg = JSON.parse(readFileSync(configPath, 'utf8'))
  if (!Number.isInteger(cfg.port) || cfg.port < 1 || cfg.port > 65535 || typeof cfg.seatId !== 'string' || !cfg.seatId || typeof cfg.seatToken !== 'string' || !/^[a-f0-9]{64}$/.test(cfg.seatToken)) {
    console.error('Invalid seat receipt configuration.')
    process.exitCode = 1
    return
  }

  const payload = JSON.stringify({
    seatToken: cfg.seatToken,
    groupId: cfg.groupId,
    seatId: cfg.seatId,
    cli: cfg.cli,
    generation: cfg.generation,
    round: cfg.round,
    head: cfg.head,
    base: cfg.base,
    kind,
    remoteId: Number(remoteId),
    itemType,
  })

  // Desktop answers once it has checked the receipt on the PR host, which can wait behind other reviewers' checks. If
  // it does not answer in time, stop: Desktop keeps checking, and sending the same receipt again gets that result.
  // COPILOT_DESKTOP_SEAT_RECEIPT_TIMEOUT_MS shortens the wait for tests.
  const timeoutMs = Number(process.env.COPILOT_DESKTOP_SEAT_RECEIPT_TIMEOUT_MS) > 0 ? Number(process.env.COPILOT_DESKTOP_SEAT_RECEIPT_TIMEOUT_MS) : 120_000
  const answer = await new Promise((resolveReq, rejectReq) => {
    const settle = (finish) => (value) => { clearTimeout(deadline); finish(value) }
    const resolveOnce = settle(resolveReq)
    const rejectOnce = settle(rejectReq)
    const req = request(
      {
        host: '127.0.0.1',
        port: cfg.port,
        path: '/pr-seat-receipt',
        method: 'POST',
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'content-length': Buffer.byteLength(payload),
        },
      },
      (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('error', rejectOnce)
        res.on('end', () => resolveOnce({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }))
      },
    )
    const deadline = setTimeout(() => {
      rejectOnce(new Error(`Copilot CLI Desktop did not answer within ${Math.ceil(timeoutMs / 1000)} seconds. It may still be checking the receipt: run the same command again to get the result.`))
      req.destroy()
    }, timeoutMs)
    req.on('error', rejectOnce)
    req.end(payload)
  })

  if (answer.status !== 200) {
    console.error(`Seat receipt rejected (${answer.status}): ${answer.text}`)
    process.exitCode = 1
    return
  }
  const parsed = JSON.parse(answer.text)
  console.log(parsed.message ?? answer.text)
  if (!parsed.ok) process.exitCode = 1
}

main().catch((error) => {
  console.error(error?.message || String(error))
  process.exitCode = 1
})

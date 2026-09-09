import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { UsageLedger } from './usage-ledger.js'

test('forced process termination retains committed WAL data and discards an unfinished transaction', async () => {
  const root = await mkdtemp(join(tmpdir(), 'usage-crash-test-'))
  const path = join(root, 'usage.sqlite')
  new UsageLedger(path).close()
  try {
    for (const committed of [true, false]) {
      const script = `import {DatabaseSync} from 'node:sqlite';
        const db=new DatabaseSync(process.argv[1]);
        db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; BEGIN IMMEDIATE');
        const sample={key:process.argv[2],session:'session',model:'model',kind:'request',at:'2026-09-08T00:00:00Z',start:null,input:50,output:20,cacheRead:40,cacheWrite:10,reasoning:0};
        db.prepare('INSERT INTO samples VALUES (?,?)').run(sample.key,JSON.stringify(sample));
        if(process.argv[2]==='committed') db.exec('COMMIT');
        process.stdout.write('ready'); setInterval(()=>{},1000);`
      const child = spawn(process.execPath, ['--input-type=module', '-e', script, path, committed ? 'committed' : 'unfinished'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      const exited = once(child, 'exit')
      let timer: NodeJS.Timeout | undefined
      try {
        await Promise.race([
          once(child.stdout!, 'data'),
          exited.then(() => { throw new Error('Writer exited before reaching the crash point') }),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Writer did not reach crash point')), 5000) }),
        ])
      } finally { if (timer) clearTimeout(timer); child.kill('SIGKILL'); await exited }
      const recovered = new UsageLedger(path)
      try { assert.equal(recovered.report('2026-09', 'all', 'UTC').totals.input, 50) } finally { recovered.close() }
    }
  } finally { await rm(root, { recursive: true, force: true }) }
})

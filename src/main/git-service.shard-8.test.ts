// Shard 8 of the git service tests (see fixtures/sharded-test.ts).
import { setTestShard } from './fixtures/sharded-test.js'

setTestShard(7, 16)
await import('./git-service.suite.js')

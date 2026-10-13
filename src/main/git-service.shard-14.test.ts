// Shard 14 of the git service tests (see fixtures/sharded-test.ts).
import { setTestShard } from './fixtures/sharded-test.js'

setTestShard(13, 16)
await import('./git-service.suite.js')

// Shard 12 of the git service tests (see fixtures/sharded-test.ts).
import { setTestShard } from './fixtures/sharded-test.js'

setTestShard(11, 16)
await import('./git-service.suite.js')

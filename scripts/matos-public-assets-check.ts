import {resolve} from 'node:path'
process.argv[2] ??= resolve(import.meta.dir,'../distribution/benchmark-minimal/assets')
process.argv[3] ??= 'workspace'
await import('./matos-minimal-assets-check.js')

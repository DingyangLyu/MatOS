import { ensureMatOSStandaloneTmp } from '../src/matos/standaloneTmp'
const storage = process.argv[2]
if (!storage) throw new Error('A temporary storage directory is required')
process.stdout.write(await ensureMatOSStandaloneTmp(storage))

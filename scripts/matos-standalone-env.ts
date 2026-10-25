import { readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { standaloneEnvironmentDefaults } from '../src/matos/standaloneProfile.js'
import { ensureMatOSStandaloneTmp } from '../src/matos/standaloneTmp.js'

const cwd = resolve(process.argv[2] ?? process.cwd())
const file = resolve(cwd, '.matos/matos.json')
if (statSync(file).size > 1024 * 1024) throw new Error('MatOS project configuration exceeds 1 MiB')
const config = JSON.parse(readFileSync(file, 'utf8'))
const defaults = standaloneEnvironmentDefaults(cwd, config.standalone)
if (defaults.MATOS_STANDALONE === '1') {
  const tmp = await ensureMatOSStandaloneTmp(process.env.MATOS_TMP_DIR || process.env.MATOS_HOST_TMP_DIR || resolve(cwd, '.matos/tmp'))
  Object.assign(defaults, { TMPDIR: tmp, TMP: tmp, TEMP: tmp, MATOS_TMP_DIR: tmp, MATOS_HOST_TMP_DIR: tmp })
}
for (const [key, value] of Object.entries(defaults)) {
  process.stdout.write(`${key}\0${value}\0`)
}
process.stdout.write('__MATOS_ENV_DONE\0ok\0')

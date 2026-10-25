import { readFileSync, statSync } from 'node:fs'
import { parseDotEnvLocal } from '../ui/open-design/tools/dev/src/local-env.js'

const file = process.argv[2]
if (!file || statSync(file).size > 1024 * 1024) throw new Error('Provide an environment file smaller than 1 MiB')
for (const [key, value] of Object.entries(parseDotEnvLocal(readFileSync(file, 'utf8')))) {
  if (['HOME', 'home', 'CODEX_HOME'].includes(key)) continue
  process.stdout.write(`${key}\0${value}\0`)
}
process.stdout.write('__MATOS_ENV_DONE\0ok\0')

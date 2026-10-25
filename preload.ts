import {mkdirSync} from 'node:fs'
import {resolve} from 'node:path'
const current=process.env.TMPDIR
if(!current || current==='/tmp' || current.startsWith('/tmp/')){
 const tmp=process.env.MATOS_TEST_TMPDIR || process.env.MATOS_TMP_DIR || resolve(process.cwd(),'.matos/tmp')
 mkdirSync(tmp,{recursive:true})
 process.env.TMPDIR=tmp
 process.env.TMP=tmp
 process.env.TEMP=tmp
}

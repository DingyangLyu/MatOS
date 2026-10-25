import { mkdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ensureMatOSStandaloneAssets } from '../standaloneAssets.js'
import { assertNoSymlinkPathComponent } from '../assets/history/policy.js'
import {
  getDefaultMatOSConfig,
  getMatOSAssetsDir,
  getMatOSConfigPath,
  getMatOSDir,
  getMatOSSessionsDir,
  MATOS_ASSET_DIRS,
} from '../project.js'

type MatOSInitIO = {
  cwd: string
  stdout: (text: string) => void
  stderr: (text: string) => void
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

export async function runMatOSInit(io: MatOSInitIO, options: { standalone?: boolean; scopeRef?: string } = {}): Promise<number> {
  const matosDir = getMatOSDir(io.cwd)
  const assetsDir = getMatOSAssetsDir(io.cwd)

  if (options.standalone) {
    await mkdir(io.cwd, { recursive: true })
    await assertNoSymlinkPathComponent({ cwd: io.cwd, absolutePath: getMatOSConfigPath(io.cwd) })
  }
  await mkdir(matosDir, { recursive: true })
  await mkdir(assetsDir, { recursive: true })
  await mkdir(getMatOSSessionsDir(io.cwd), { recursive: true })

  for (const dir of MATOS_ASSET_DIRS) {
    await mkdir(join(assetsDir, dir), { recursive: true })
  }

  const configPath = getMatOSConfigPath(io.cwd)
  if (!(await pathExists(configPath))) {
    await writeFile(
      configPath,
      `${JSON.stringify(getDefaultMatOSConfig(), null, 2)}\n`,
      'utf8',
    )
  }

  if (options.standalone) await ensureMatOSStandaloneAssets(io.cwd, options)
  io.stdout('.matos initialized\n')
  return 0
}

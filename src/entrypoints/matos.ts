import { runMatOSCli } from '../matos/cli/main.js'

const originalCwd = process.env.MATOS_ORIGINAL_CWD
if (originalCwd && process.cwd() !== originalCwd) {
  process.chdir(originalCwd)
}

const exitCode = await runMatOSCli(process.argv.slice(2))

async function flushWritable(stream: NodeJS.WritableStream): Promise<void> {
  await new Promise<void>(resolve => {
    stream.write('', () => resolve())
  })
}

await Promise.all([flushWritable(process.stdout), flushWritable(process.stderr)])
process.exitCode = exitCode

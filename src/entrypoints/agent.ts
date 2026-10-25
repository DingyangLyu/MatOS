import { runMatOSAgentCli } from '../matos/host/agentCli.js'

// Child-process entry for one MatOS agent session on DeepSeek Harness.
const controller = new AbortController()
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => controller.abort(signal))
}

const exitCode = await runMatOSAgentCli(process.argv.slice(2), {
  cwd: process.cwd(),
  env: process.env,
  stdin: process.stdin,
  stdout: text => { process.stdout.write(text) },
  stderr: text => { process.stderr.write(text) },
  signal: controller.signal,
})

await Promise.all([process.stdout, process.stderr].map(stream =>
  new Promise<void>(resolve => stream.write('', () => resolve()))))
process.exit(exitCode)

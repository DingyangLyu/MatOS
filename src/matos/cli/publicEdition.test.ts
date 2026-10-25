import { expect, test } from 'bun:test'
import { runMatOSCli } from './main.js'

for (const args of [['gateway', 'serve'], ['workspace', 'list'], ['runtime', 'users', 'list']]) {
  test('public edition retires ' + args.join(' '), async () => {
    let error = ''
    const code = await runMatOSCli(args, { stdout: () => {}, stderr: text => { error += text } })
    expect(code).toBe(2)
    expect(error).toContain('single-user')
    expect(error).toContain('scripts/matos-web.sh')
  })
}

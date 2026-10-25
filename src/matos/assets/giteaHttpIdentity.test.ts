import { createServer } from 'node:http'
import { expect, test } from 'bun:test'
import { validateMatOSGiteaAccessToken } from './giteaClient.js'

test('chunked identity responses decode UTF-8 bytes before parsing the token owner', async () => {
  const server = createServer((_req, res) => {
    res.setHeader('content-type', 'application/json')
    res.write('{"full_name":"\u6750\u6599\u7814\u53d1",')
    res.write('"login":"alice"}')
    res.end()
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address() as { port: number }
    const result = await validateMatOSGiteaAccessToken({ apiUrl: `http://127.0.0.1:${address.port}/api/v1`, token: 'public-test-token' })
    expect(result).toMatchObject({ ok: true, status: 200, username: 'alice' })
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
})

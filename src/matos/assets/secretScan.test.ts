import { describe, expect, test } from 'bun:test'
import {
  hasMatOSSecretLookingContent,
  isMatOSSecretLookingFileName,
} from './secretScan.js'

describe('MatOS secret scan content', () => {
  test('flags hard-coded literal secrets', () => {
    expect(
      hasMatOSSecretLookingContent('DEEPSEEK_API_KEY=secret-value-123456789'),
    ).toBe(true)
    expect(
      hasMatOSSecretLookingContent('api_key = "sk-abcdefABCDEF0123456789"'),
    ).toBe(true)
    expect(
      hasMatOSSecretLookingContent("password: 'hunter2-supersecret-value'"),
    ).toBe(true)
    expect(
      hasMatOSSecretLookingContent('authorization=Bearer_abcdefghijklmnop'),
    ).toBe(true)
  })

  test('flags disguised hard-coded secrets that are not function calls', () => {
    // Regression guard: a too-broad "code expression" exemption let these pass.
    expect(hasMatOSSecretLookingContent('api_key = `sk-abcdef1234567890xy`')).toBe(
      true,
    ) // template literal
    expect(
      hasMatOSSecretLookingContent('api_key = b"sk-abcdef1234567890xy"'),
    ).toBe(true) // python bytes prefix
    expect(
      hasMatOSSecretLookingContent('api_key = f"sk-abcdef1234567890xy"'),
    ).toBe(true) // python f-string
    expect(
      hasMatOSSecretLookingContent('api_key = r"sk-abcdef1234567890xy"'),
    ).toBe(true) // python raw string
    expect(
      hasMatOSSecretLookingContent("api_key = ('sk-abcdef1234567890xy')"),
    ).toBe(true) // parenthesized literal
  })

  test('does not flag credential reads from config parsers, env, or vault', () => {
    // The exact line that blocked every direct-editor snapshot in matos-core.
    expect(
      hasMatOSSecretLookingContent(
        'secret_key = parser.get("default", "secret_access_key", fallback="").strip()',
      ),
    ).toBe(false)
    expect(
      hasMatOSSecretLookingContent('api_key = os.environ.get("MP_API_KEY")'),
    ).toBe(false)
    expect(hasMatOSSecretLookingContent('api_key = os.getenv("MP_API_KEY")')).toBe(
      false,
    )
    expect(
      hasMatOSSecretLookingContent('api_key = process.env.MP_API_KEY'),
    ).toBe(false)
    expect(
      hasMatOSSecretLookingContent('secret = config.get_secret("prod-token")'),
    ).toBe(false)
    expect(
      hasMatOSSecretLookingContent('access_secret = vault.read("kv/data/app")'),
    ).toBe(false)
  })

  test('does not flag type hints or placeholders', () => {
    expect(hasMatOSSecretLookingContent('api_key: Optional[str] = None')).toBe(
      false,
    )
    expect(
      hasMatOSSecretLookingContent('password = "your_api_key_here"'),
    ).toBe(false)
    expect(hasMatOSSecretLookingContent('auth_token = "${VAULT_TOKEN}"')).toBe(
      false,
    )
  })

  test('flags secret-looking file names but not ordinary source files', () => {
    expect(isMatOSSecretLookingFileName('.env')).toBe(true)
    expect(isMatOSSecretLookingFileName('.env.production')).toBe(true)
    expect(isMatOSSecretLookingFileName('id_rsa')).toBe(true)
    expect(isMatOSSecretLookingFileName('server.key')).toBe(true)
    expect(isMatOSSecretLookingFileName('tool.py')).toBe(false)
    expect(isMatOSSecretLookingFileName('asset.json')).toBe(false)
  })
})

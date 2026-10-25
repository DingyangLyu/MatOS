const SECRET_ASSIGNMENT_PATTERN =
  /(?:^|[^\w.-])([A-Za-z0-9_.-]*(?:api[_-]?key|auth[_-]?token|secret|password|authorization)[A-Za-z0-9_.-]*)[ \t]*[:=][ \t]*(?:"([^"\n]{12,})"|'([^'\n]{12,})'|([^\s,;)}\]]{12,}))/gim

// Generic credential-suffix assignments (MATOS_GITEA_TOKEN=..., *_TOKEN=,
// *_KEY=, ACCESS-KEY: ...). The identifier must end with a delimited
// token/key word so ordinary identifiers such as "monkey" or "turkey" never
// match; the value additionally must look credential-like (see
// isCredentialLikeValue) because generic *_key names (sort_key, cache_key,
// partition_key, ...) are common in ordinary code and docs.
const GENERIC_CREDENTIAL_ASSIGNMENT_PATTERN =
  /(?:^|[^\w.-])([A-Za-z0-9_.-]*[_-](?:token|key))[ \t]*[:=][ \t]*(?:"([^"\n]{12,})"|'([^'\n]{12,})'|([^\s,;)}\]]{12,}))/gim

// PEM-style private key bodies (RSA/EC/DSA/OPENSSH/PGP "PRIVATE KEY BLOCK").
const PRIVATE_KEY_BLOCK_PATTERN = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/

// Bare provider-style keys (sk-...) even without an assignment context.
const BARE_PROVIDER_KEY_PATTERN = /(?:^|[^A-Za-z0-9_-])(sk-[A-Za-z0-9_-]{16,})(?![A-Za-z0-9_-])/gm

// URL userinfo credentials (https://user:token@host), the shape stored in
// .git-credentials files and often pasted into remotes/config examples.
const URL_CREDENTIAL_PATTERN = /\bhttps?:\/\/[^\s/@:]{1,64}:([^\s/@]{6,})@[\w.-]+/gi

// netrc-style credential blocks: a "machine <host>" declaration plus a
// "password <value>" token in the same file (covers renamed .netrc payloads).
// The machine argument must look like a hostname (dotted or localhost) so
// prose such as "machine learning" at a line start never matches.
const NETRC_MACHINE_PATTERN = /^[ \t]*machine[ \t]+(?:[\w-]+(?:\.[\w-]+)+|localhost)\b/im
const NETRC_PASSWORD_PATTERN = /(?:^|[ \t])password[ \t]+(\S{6,})/im

const BENIGN_SECRET_VALUE_PREFIXES = [
  '<',
  '$',
  '${',
  'process.env',
  'os.environ',
  'os.getenv',
  'env.',
  'getenv',
  'config.',
  'settings.',
  'args.',
  'self.',
  'headers[',
  'params[',
  'replace',
  'example',
  'dummy',
  'test',
  'your_',
  'your-',
  'your ',
  'placeholder',
  'optional[',
  'list[',
  'dict[',
  'tuple[',
  'set[',
  'api-key-here',
]

const PLACEHOLDER_VALUE_PATTERN =
  /your|example|placeholder|dummy|redacted|sample|xxxx|test[-_]?key|test[-_]?token/i

export function isMatOSSecretLookingFileName(path: string): boolean {
  const name = path.split(/[\\/]/).pop() ?? path
  return (
    name === '.env' ||
    name.startsWith('.env.') ||
    // Any *.env file (operator.env, deploy.env, ...) is an env payload.
    /\.env$/i.test(name) ||
    name === '.netrc' ||
    name === '_netrc' ||
    name === '.git-credentials' ||
    /\.(pem|key|p12|pfx)$/i.test(name) ||
    /^id_(rsa|dsa|ecdsa|ed25519)$/i.test(name)
  )
}

function isBenignSecretValueReference(value: string): boolean {
  const trimmed = value.trim().replace(/^\\*["']+/, '').replace(/\\*["']+$/, '')
  const lower = trimmed.toLowerCase()
  return BENIGN_SECRET_VALUE_PREFIXES.some(prefix => lower.startsWith(prefix))
}

// A bare (unquoted) assignment value is treated as benign code ONLY when it is a
// function call or attribute-read expression: an identifier or dotted path
// immediately followed by "(", e.g. parser.get("secret_access_key"),
// os.getenv("MP_API_KEY"), or read_secret(). This intentionally does NOT exempt
// disguised literals that merely contain a quote/paren/backtick: template
// literals (`sk-...`), prefixed strings (b"sk-...", f"...", r"..."), and
// parenthesized literals (("sk-...")) are not function calls and stay flagged.
function isCodeExpressionBareValue(bareValue: string): boolean {
  return /[A-Za-z_$][\w.$]*\(/.test(bareValue)
}

// Generic *_token/*_key values must look like actual credential material:
// at least one digit, no template/interpolation braces, and no test/demo
// placeholder words. This keeps sort_key = "created_at_desc", cache_key =
// f"{id}_{run}", and fixture values like "v1:test-signed-token" out of the
// findings while MATOS_GITEA_TOKEN=e3b0c44298fc... style values stay flagged.
function isCredentialLikeValue(value: string): boolean {
  return (
    /\d/.test(value) &&
    !/[{}]/.test(value) &&
    !/(?:^|[^a-z])(?:test|example|dummy|sample|placeholder|fake|demo|mock)(?:[^a-z]|$)/i.test(
      value,
    )
  )
}

function matchesSecretAssignment(
  text: string,
  pattern: RegExp,
  options: { requireCredentialLikeValue: boolean },
): boolean {
  pattern.lastIndex = 0
  for (;;) {
    const match = pattern.exec(text)
    if (!match) {
      return false
    }
    const quotedValue = match[2] ?? match[3]
    if (quotedValue !== undefined) {
      if (options.requireCredentialLikeValue && !isCredentialLikeValue(quotedValue)) {
        continue
      }
      if (!isBenignSecretValueReference(quotedValue)) {
        return true
      }
      continue
    }
    const bareValue = match[4] ?? ''
    if (options.requireCredentialLikeValue && !isCredentialLikeValue(bareValue)) {
      continue
    }
    if (!isCodeExpressionBareValue(bareValue) && !isBenignSecretValueReference(bareValue)) {
      return true
    }
  }
}

function hasBareProviderKey(text: string): boolean {
  BARE_PROVIDER_KEY_PATTERN.lastIndex = 0
  for (;;) {
    const match = BARE_PROVIDER_KEY_PATTERN.exec(text)
    if (!match) {
      return false
    }
    if (!PLACEHOLDER_VALUE_PATTERN.test(match[1] ?? '')) {
      return true
    }
  }
}

function hasUrlCredential(text: string): boolean {
  URL_CREDENTIAL_PATTERN.lastIndex = 0
  for (;;) {
    const match = URL_CREDENTIAL_PATTERN.exec(text)
    if (!match) {
      return false
    }
    const password = match[1] ?? ''
    if (
      !PLACEHOLDER_VALUE_PATTERN.test(password) &&
      !isBenignSecretValueReference(password) &&
      !/^pass(?:word)?$/i.test(password) &&
      !/^token$/i.test(password)
    ) {
      return true
    }
  }
}

function hasNetrcCredential(text: string): boolean {
  if (!NETRC_MACHINE_PATTERN.test(text)) {
    return false
  }
  const match = text.match(NETRC_PASSWORD_PATTERN)
  if (!match) {
    return false
  }
  const password = match[1] ?? ''
  return !PLACEHOLDER_VALUE_PATTERN.test(password) && !isBenignSecretValueReference(password)
}

export function hasMatOSSecretLookingContent(text: string): boolean {
  if (
    matchesSecretAssignment(text, SECRET_ASSIGNMENT_PATTERN, {
      requireCredentialLikeValue: false,
    })
  ) {
    return true
  }
  if (
    matchesSecretAssignment(text, GENERIC_CREDENTIAL_ASSIGNMENT_PATTERN, {
      requireCredentialLikeValue: true,
    })
  ) {
    return true
  }
  if (PRIVATE_KEY_BLOCK_PATTERN.test(text)) {
    return true
  }
  if (hasBareProviderKey(text)) {
    return true
  }
  if (hasUrlCredential(text)) {
    return true
  }
  return hasNetrcCredential(text)
}

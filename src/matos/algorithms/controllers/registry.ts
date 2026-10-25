import {
  createMatOSControllerSearchBounds,
  type MatOSControllerJsonValue,
  type MatOSControllerSearchBounds,
  type MatOSRunController,
} from './protocol.js'

export type MatOSControllerProviderCreateInput<
  Config extends MatOSControllerJsonValue = MatOSControllerJsonValue,
> = Readonly<{
  config: Readonly<Config>
  seed: number
  bounds: MatOSControllerSearchBounds
}>

export type MatOSControllerProvider<
  State = unknown,
  Config extends MatOSControllerJsonValue = MatOSControllerJsonValue,
> = Readonly<{
  id: string
  version: string
  stateVersion: number
  /**
   * Stable identity of the provider implementation, independent of its
   * user-facing id/version. Providers must change this digest whenever their
   * executable implementation changes.
   */
  implementationDigest: string
  /** Accepted asset identity for asset-backed controller providers. */
  assetRef?: string
  /** Immutable runtime/commit identity used to materialize the provider. */
  runtimeRef?: string
  description?: string
  create: (
    input: MatOSControllerProviderCreateInput<Config>,
  ) => MatOSRunController<State>
}>

export type MatOSControllerProviderDescriptor = Readonly<{
  id: string
  version: string
  stateVersion: number
  implementationDigest: string
  assetRef?: string
  runtimeRef?: string
  description?: string
}>

export class MatOSControllerRegistryError extends Error {
  readonly code:
    | 'invalid-provider'
    | 'duplicate-provider'
    | 'unknown-provider'
    | 'provider-contract-mismatch'

  constructor(
    code: MatOSControllerRegistryError['code'],
    message: string,
  ) {
    super(message)
    this.name = 'MatOSControllerRegistryError'
    this.code = code
  }
}

function normalizedId(value: string): string {
  const normalized = value.trim().toLowerCase()
  if (!/^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/.test(normalized)) {
    throw new MatOSControllerRegistryError(
      'invalid-provider',
      `invalid controller provider id ${JSON.stringify(value)}`,
    )
  }
  return normalized
}

function normalizedVersion(value: string): string {
  const normalized = value.trim()
  if (!normalized || normalized.length > 128 || /\s/.test(normalized)) {
    throw new MatOSControllerRegistryError(
      'invalid-provider',
      `invalid controller provider version ${JSON.stringify(value)}`,
    )
  }
  return normalized
}

function normalizedDigest(value: unknown, path: string): string {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (!/^[a-f0-9]{64}$/.test(normalized)) {
    throw new MatOSControllerRegistryError(
      'invalid-provider',
      `${path} must be a lowercase sha256 digest`,
    )
  }
  return normalized
}

function normalizedReference(
  value: unknown,
  path: string,
): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') {
    throw new MatOSControllerRegistryError(
      'invalid-provider',
      `${path} must be a non-empty bounded reference`,
    )
  }
  const normalized = value.trim()
  if (!normalized || normalized.length > 4096 || normalized.includes('\0')) {
    throw new MatOSControllerRegistryError(
      'invalid-provider',
      `${path} must be a non-empty bounded reference`,
    )
  }
  return normalized
}

function providerKey(id: string, version: string): string {
  return `${id}@${version}`
}

function compareVersion(left: string, right: string): number {
  return left.localeCompare(right, 'en', {
    numeric: true,
    sensitivity: 'base',
  })
}

function validateProvider(
  provider: MatOSControllerProvider<unknown>,
): MatOSControllerProvider<unknown> {
  const id = normalizedId(provider.id)
  const version = normalizedVersion(provider.version)
  const implementationDigest = normalizedDigest(
    provider.implementationDigest,
    `controller provider ${id}@${version} implementationDigest`,
  )
  const assetRef = normalizedReference(provider.assetRef, 'provider.assetRef')
  const runtimeRef = normalizedReference(provider.runtimeRef, 'provider.runtimeRef')
  if (
    !Number.isSafeInteger(provider.stateVersion) ||
    provider.stateVersion < 1 ||
    typeof provider.create !== 'function'
  ) {
    throw new MatOSControllerRegistryError(
      'invalid-provider',
      `controller provider ${id}@${version} has an invalid contract`,
    )
  }
  return Object.freeze({
    ...provider,
    id,
    version,
    implementationDigest,
    ...(assetRef ? { assetRef } : {}),
    ...(runtimeRef ? { runtimeRef } : {}),
  })
}

export class MatOSControllerRegistry {
  readonly #providers = new Map<string, MatOSControllerProvider<unknown>>()

  register<State, Config extends MatOSControllerJsonValue>(
    provider: MatOSControllerProvider<State, Config>,
  ): void {
    const validated = validateProvider(
      provider as MatOSControllerProvider<unknown>,
    )
    const key = providerKey(validated.id, validated.version)
    if (this.#providers.has(key)) {
      throw new MatOSControllerRegistryError(
        'duplicate-provider',
        `controller provider ${key} is already registered`,
      )
    }
    this.#providers.set(key, validated)
  }

  unregister(providerId: string, version: string): boolean {
    return this.#providers.delete(
      providerKey(normalizedId(providerId), normalizedVersion(version)),
    )
  }

  resolve<State = unknown, Config extends MatOSControllerJsonValue = MatOSControllerJsonValue>(
    providerId: string,
    version?: string,
  ): MatOSControllerProvider<State, Config> {
    const id = normalizedId(providerId)
    let provider: MatOSControllerProvider<unknown> | undefined
    if (version !== undefined) {
      provider = this.#providers.get(
        providerKey(id, normalizedVersion(version)),
      )
    } else {
      provider = [...this.#providers.values()]
        .filter(candidate => candidate.id === id)
        .sort((left, right) => compareVersion(right.version, left.version))[0]
    }
    if (!provider) {
      throw new MatOSControllerRegistryError(
        'unknown-provider',
        `unknown controller provider ${providerKey(id, version ?? 'latest')}`,
      )
    }
    return provider as MatOSControllerProvider<State, Config>
  }

  create<State, Config extends MatOSControllerJsonValue>(input: {
    providerId: string
    version: string
    config: Config
    seed: number
    bounds: MatOSControllerSearchBounds
    expectedImplementationDigest?: string
    expectedAssetRef?: string
    expectedRuntimeRef?: string
  }): MatOSRunController<State> {
    const provider = this.resolve<State, Config>(input.providerId, input.version)
    if (
      (input.expectedImplementationDigest !== undefined &&
        provider.implementationDigest !== input.expectedImplementationDigest) ||
      (input.expectedAssetRef !== undefined &&
        provider.assetRef !== input.expectedAssetRef) ||
      (input.expectedRuntimeRef !== undefined &&
        provider.runtimeRef !== input.expectedRuntimeRef)
    ) {
      throw new MatOSControllerRegistryError(
        'provider-contract-mismatch',
        `provider ${provider.id}@${provider.version} does not match its pinned implementation identity`,
      )
    }
    const controller = provider.create({
      config: input.config,
      seed: input.seed,
      bounds: createMatOSControllerSearchBounds(input.bounds),
    })
    if (
      normalizedId(controller.id) !== provider.id ||
      normalizedVersion(controller.version) !== provider.version ||
      controller.stateVersion !== provider.stateVersion
    ) {
      throw new MatOSControllerRegistryError(
        'provider-contract-mismatch',
        `provider ${provider.id}@${provider.version} created an incompatible controller`,
      )
    }
    return controller
  }

  list(): MatOSControllerProviderDescriptor[] {
    return [...this.#providers.values()]
      .sort(
        (left, right) =>
          left.id.localeCompare(right.id) ||
          compareVersion(left.version, right.version),
      )
      .map(provider =>
        Object.freeze({
          id: provider.id,
          version: provider.version,
          stateVersion: provider.stateVersion,
          implementationDigest: provider.implementationDigest,
          ...(provider.assetRef ? { assetRef: provider.assetRef } : {}),
          ...(provider.runtimeRef ? { runtimeRef: provider.runtimeRef } : {}),
          ...(provider.description
            ? { description: provider.description }
            : {}),
        }),
      )
  }
}

export function createMatOSControllerRegistry(): MatOSControllerRegistry {
  return new MatOSControllerRegistry()
}

export const matOSControllerRegistry = createMatOSControllerRegistry()

export function registerMatOSControllerProvider<
  State,
  Config extends MatOSControllerJsonValue,
>(provider: MatOSControllerProvider<State, Config>): void {
  matOSControllerRegistry.register(provider)
}

export function resolveMatOSControllerProvider<
  State = unknown,
  Config extends MatOSControllerJsonValue = MatOSControllerJsonValue,
>(
  providerId: string,
  version?: string,
): MatOSControllerProvider<State, Config> {
  return matOSControllerRegistry.resolve(providerId, version)
}

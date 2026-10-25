import type { MatOSAsset } from './types.js'

// Hidden roles remain available to the native background pipeline, but are
// not user-launchable roles. This is a product boundary, not OS isolation.
export function assertMatOSRoleUserInvocable(
  role: MatOSAsset | undefined,
  internalHidden = false,
): void {
  if (role?.metadata.hidden === true && !internalHidden) {
    throw new Error(`MatOS role ${role.canonicalKey} is reserved for internal background execution`)
  }
}

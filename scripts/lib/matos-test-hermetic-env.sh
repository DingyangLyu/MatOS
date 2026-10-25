#!/usr/bin/env bash
# Hermetic test environment for MatOS unit/integration suites.
#
# Deployment shells can carry `.env.deploy` exports (deployment data roots,
# shared/global asset roots). Tests that build their own temp deployments
# would then read the live deployment paths instead of their fixtures and
# fail spuriously. Scrub deployment-identity variables before running
# tests; provider credentials/model routing are intentionally kept because
# real-LLM tests need them.
#
# Opt out (e.g. for an explicit deployment-coupled check) with
# MATOS_TEST_KEEP_DEPLOY_ENV=1.

# Workspace creation refuses to build containers without provider
# credentials. Test suites create fake-docker workspaces
# in shells that may legitimately lack provider secrets, so opt the whole suite
# out; the guard's own tests pass explicit process envs to stay strict.
export MATOS_WORKSPACE_ALLOW_NO_PROVIDER_ENV=1

if [[ "${MATOS_TEST_KEEP_DEPLOY_ENV:-0}" != "1" ]]; then
  unset \
    MATOS_DEPLOY_ROOT \
    MATOS_DEPLOY_PROFILE \
    MATOS_DEPLOY_AUTO_ADMIN \
    MATOS_DATA_DIR \
    MATOS_RUNTIME_DATA_DIR \
    MATOS_BACKUP_ROOT \
    MATOS_GOVERNANCE_ROOT \
    MATOS_OPS_ROOT \
    MATOS_SHARED_ASSET_ROOT \
    MATOS_TEAM_ASSET_ROOT \
    MATOS_GLOBAL_ASSET_ROOT \
    MATOS_BUNDLED_ASSET_ROOT \
    MATOS_GATEWAY_CHANNEL \
    MATOS_GATEWAY_DATA_DIR \
    MATOS_GATEWAY_HOST \
    MATOS_GATEWAY_USER_ENTRY \
    MATOS_OPENVSCODE_SOCKET_DIR
fi

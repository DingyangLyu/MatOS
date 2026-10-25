import type { MatOSAsset } from '../assets/types.js';
import type {
MatOSWorkbenchAction,
MatOSWorkbenchActionContract,
MatOSWorkbenchActionKey,
MatOSWorkbenchCommandRoute,
MatOSWorkbenchOperatorReview,
} from './types.js';

function command(argv: string[]): { argv: string[]; command: string } {
  return {
    argv,
    command: `matos ${argv.map(arg => JSON.stringify(arg)).join(' ')}`,
  }
}

function action(input: {
  key: MatOSWorkbenchActionKey
  label: string
  enabled?: boolean
  maturity?: MatOSWorkbenchAction['maturity']
  reason?: string
  danger?: boolean
  requiresConfirmation?: boolean
  argv?: string[]
  operatorReview?: MatOSWorkbenchOperatorReview
}): MatOSWorkbenchAction {
  const route = input.argv ? command(input.argv) : undefined
  const enabled = input.enabled ?? true
  const maturity = input.maturity ?? (route ? 'route-only' : 'read-only')
  const operatorReview = input.operatorReview ?? defaultOperatorReviewForAction({
    key: input.key,
    maturity,
    route,
    enabled,
    reason: input.reason,
  })
  return {
    key: input.key,
    label: input.label,
    enabled,
    maturity,
    ...(input.reason ? { reason: input.reason } : {}),
    ...(input.danger ? { danger: true } : {}),
    ...(input.requiresConfirmation ? { requiresConfirmation: true } : {}),
    ...(route ? { command: route } : {}),
    ...(operatorReview ? { operatorReview } : {}),
    contract: actionContract({
      key: input.key,
      maturity,
      enabled,
      reason: input.reason,
      danger: input.danger === true,
      requiresConfirmation: input.requiresConfirmation === true,
      route,
      operatorReview,
    }),
  }
}

function defaultOperatorReviewForAction(input: {
  key: MatOSWorkbenchActionKey
  maturity: NonNullable<MatOSWorkbenchAction['maturity']>
  route?: MatOSWorkbenchCommandRoute
  enabled: boolean
  reason?: string
}): MatOSWorkbenchOperatorReview | undefined {
  if (input.maturity === 'read-only') {
    return undefined
  }
  if (input.maturity === 'route-only') {
    return {
      mode: 'native-operator-review',
      status: 'preview-only',
      policy: 'native-route',
      reason:
        input.reason ??
        'This workbench action exposes a native MatOS route. The workspace previews the route and does not execute it automatically.',
      ...(input.route
        ? {
            nativeNextStep: {
              label: 'Open native MatOS route',
              description: 'Execute the listed MatOS CLI route explicitly if this user action should continue.',
              route: input.route,
            },
          }
        : {}),
    }
  }
  return {
    mode: 'native-operator-review',
    status: input.enabled ? 'confirmation-required' : 'blocked',
    policy: 'project-local-controlled-write',
    reason:
      input.reason ??
      'This workbench action is a controlled native MatOS mutation and requires explicit confirmation, permission checks, history, rollback, and audit evidence before apply.',
    ...(input.route
      ? {
          nativeNextStep: {
            label: 'Preview native controlled action',
            description: 'Use this MatOS route to obtain the current preview, validation evidence, and confirmation fingerprint.',
            route: input.route,
          },
        }
      : {}),
  }
}

function actionInputSchema(key: MatOSWorkbenchActionKey): Record<string, unknown> {
  if (key === 'attach' || key === 'detach') {
    return {
      type: 'object',
      additionalProperties: true,
      properties: {
        assetRef: {
          type: 'string',
          description: 'Canonical MatOS asset ref to attach/detach when the selected resource is a role.',
        },
        targetRef: {
          type: 'string',
          description: 'Canonical MatOS role ref when the selected resource is an attachable asset.',
        },
        group: {
          type: 'string',
          description: 'Optional MatOS role mount group override, such as tools, workflows, knowledge, data, skills, mcp, or plugins.',
        },
        operation: {
          type: 'string',
          enum: ['attach', 'detach'],
        },
        confirmationFingerprint: {
          type: 'string',
          description: 'Required only when applying the controlled write.',
        },
        reason: { type: 'string' },
      },
    }
  }
  if (key === 'run' || key === 'debug') {
    return {
      type: 'object',
      additionalProperties: true,
      properties: {
        prompt: { type: 'string' },
        parameters: { type: 'object' },
      },
    }
  }
  if (key === 'duplicate') {
    return {
      type: 'object',
      additionalProperties: true,
      properties: {
        targetRef: {
          type: 'string',
          description: 'Optional canonical MatOS target ref for the project-local duplicated asset.',
        },
        targetId: {
          type: 'string',
          description: 'Optional target asset id. MatOS will select a deterministic non-conflicting id when omitted.',
        },
        name: {
          type: 'string',
          description: 'Optional display name for the duplicated project-local asset.',
        },
        confirmationFingerprint: {
          type: 'string',
          description: 'Required only when applying the controlled duplicate write.',
        },
        reason: { type: 'string' },
      },
    }
  }
  if (key === 'respond') {
    return {
      type: 'object',
      required: ['nodeId', 'message'],
      additionalProperties: false,
      properties: {
        nodeId: { type: 'string' },
        message: { type: 'string' },
      },
    }
  }
  if (
    key === 'publish' ||
    key === 'approve' ||
    key === 'rollback' ||
    key === 'disable' ||
    key === 'enable' ||
    key === 'commit-source' ||
    key === 'accept-source' ||
    key === 'rollback-source'
  ) {
    return {
      type: 'object',
      required: ['confirmationFingerprint'],
      additionalProperties: true,
      properties: {
        confirmationFingerprint: { type: 'string' },
        reason: { type: 'string' },
        ...(key === 'rollback' ? { releaseId: { type: 'string' } } : {}),
        ...(key === 'publish'
          ? {
              snapshotRef: { type: 'string' },
              releaseName: { type: 'string' },
            }
          : {}),
      },
    }
  }
  return {
    type: 'object',
    additionalProperties: false,
    properties: {},
  }
}

function actionEffects(key: MatOSWorkbenchActionKey): MatOSWorkbenchActionContract['effects'] {
  if (key === 'run') {
    return ['execute', 'workflow-run']
  }
  if (key === 'debug') {
    return ['execute', 'model-call']
  }
  if (
    key === 'attach' ||
    key === 'detach' ||
    key === 'publish' ||
    key === 'approve' ||
    key === 'reject' ||
    key === 'rollback' ||
    key === 'duplicate' ||
    key === 'disable' ||
    key === 'enable' ||
    key === 'commit-source' ||
    key === 'accept-source' ||
    key === 'rollback-source'
  ) {
    return ['write', 'asset-history']
  }
  if (key === 'respond') {
    return ['write', 'human-input']
  }
  return ['read']
}

function actionContract(input: {
  key: MatOSWorkbenchActionKey
  maturity: NonNullable<MatOSWorkbenchAction['maturity']>
  enabled: boolean
  reason?: string
  danger: boolean
  requiresConfirmation: boolean
  route?: MatOSWorkbenchCommandRoute
  operatorReview?: MatOSWorkbenchOperatorReview
}): MatOSWorkbenchAction['contract'] {
  return {
    source: 'matos-action-contract',
    inputSchema: actionInputSchema(input.key),
    outputSchema: {
      type: 'object',
      additionalProperties: true,
      properties: {
        ok: { type: 'boolean' },
        matos: { type: 'object' },
      },
    },
    effects: actionEffects(input.key),
    permission: {
      maturity: input.maturity,
      enabled: input.enabled,
      requiresConfirmation: input.requiresConfirmation,
      danger: input.danger,
      ...(input.reason ? { reason: input.reason } : {}),
    },
    native: {
      ...(input.route ? { route: input.route } : {}),
      previewEndpoint: input.key === 'duplicate' ? 'search.duplicate' : 'resources.invoke-action',
      ...(input.maturity === 'controlled-mutation'
        ? { applyEndpoint: input.key === 'duplicate' ? 'search.duplicate-apply' : 'native-matos-command' }
        : {}),
    },
    ...(input.operatorReview ? { operatorReview: input.operatorReview } : {}),
  }
}

function assetRef(asset: MatOSAsset): string {
  return asset.canonicalKey || `${asset.type}:${asset.id}`
}

function workflowKind(asset: MatOSAsset): string {
  const workflow =
    asset.runtime.workflow &&
    typeof asset.runtime.workflow === 'object' &&
    !Array.isArray(asset.runtime.workflow)
      ? (asset.runtime.workflow as Record<string, unknown>)
      : {}
  return typeof workflow.kind === 'string' ? workflow.kind : 'executable'
}

function canRunWorkflow(asset: MatOSAsset): boolean {
  return asset.lifecycle.status === 'enabled' && workflowKind(asset) !== 'component'
}

function attachableToRole(asset: MatOSAsset): boolean {
  return (
    asset.type === 'workflow' ||
    asset.type === 'tool' ||
    asset.type === 'skill' ||
    asset.type === 'plugin' ||
    asset.type === 'mcp' ||
    asset.type === 'knowledge' ||
    asset.type === 'data'
  )
}

function assetLifecycleSource(asset: MatOSAsset): string {
  const visibility = [
    asset.metadata.visibility,
    asset.metadata.scope,
    asset.metadata.scopeRef,
    (asset.metadata.marketplace && typeof asset.metadata.marketplace === 'object'
      ? (asset.metadata.marketplace as Record<string, unknown>).visibility
      : undefined),
  ].find(value => typeof value === 'string' && value.trim())
  return typeof visibility === 'string' && visibility.trim()
    ? `${asset.source}:${visibility.trim()}`
    : asset.source
}

function assetSourceId(asset: MatOSAsset): string | undefined {
  const provenance =
    asset.metadata.sourceProvenance &&
    typeof asset.metadata.sourceProvenance === 'object' &&
    !Array.isArray(asset.metadata.sourceProvenance)
      ? (asset.metadata.sourceProvenance as Record<string, unknown>)
      : {}
  const sourceId = provenance.sourceId
  return typeof sourceId === 'string' && sourceId.trim() ? sourceId.trim() : undefined
}

function releaseOperatorReviewForAsset(
  asset: MatOSAsset,
  actionKey: 'publish' | 'rollback' | 'approve' | 'reject',
): MatOSWorkbenchOperatorReview {
  const ref = assetRef(asset)
  const source = assetLifecycleSource(asset)
  const projectLocal = asset.source === 'project'
  const actionLabel = actionKey === 'approve' ? 'publish' : actionKey
  return {
    mode: 'native-operator-review',
    status: projectLocal ? 'confirmation-required' : 'blocked',
    policy: projectLocal ? 'asset-history-release' : 'shared-global-promotion-blocked',
    targetRef: ref,
    targetType: asset.type as MatOSWorkbenchOperatorReview['targetType'],
    source,
    reason: projectLocal
      ? `Project-local ${actionLabel} is available only through MatOS asset-history release preview/apply with the current confirmation fingerprint.`
      : `Shared/global/core promotion for ${ref} needs a promotion policy and is not writable from the workspace; use the native preview to inspect evidence.`,
    scopeGate: {
      allowedSources: ['project'],
      actualSource: source,
      status: projectLocal ? 'passed' : 'blocked',
      reason: projectLocal
        ? 'The target is project-local and can use the asset-history release writer after confirmation.'
        : 'The target is not project-local. Shared/global/core promotion requires a separate operator policy and promotion writer.',
    },
    nativeNextStep: projectLocal
      ? {
          label: 'Apply native release action',
          description: 'First preview the release packet, then re-run apply with the current confirmation fingerprint.',
          route: command([
            'workbench',
            'releases',
            'apply',
            ref,
            '--action',
            actionLabel === 'rollback' ? 'rollback' : 'publish',
            '--fingerprint',
            '<sha256>',
            '--json',
          ]),
        }
      : {
          label: 'Inspect native release preview',
          description: 'Preview remains available for operator review, but persistent shared/global/core promotion is blocked in this facade.',
          route: command([
            'workbench',
            'releases',
            'preview',
            ref,
            '--action',
            actionLabel === 'rollback' ? 'rollback' : 'publish',
            '--include-hidden',
            '--json',
          ]),
        },
  }
}

export function buildMatOSWorkbenchActionsForAsset(
  asset: MatOSAsset,
): MatOSWorkbenchAction[] {
  const ref = assetRef(asset)
  const enabled = asset.lifecycle.status === 'enabled'
  const sourceId = assetSourceId(asset)
  const actions: MatOSWorkbenchAction[] = [
    action({
      key: 'open',
      label: 'Open',
      argv: ['workbench', 'resources', 'show', ref, '--json'],
    }),
    action({
      key: 'view-lineage',
      label: 'Lineage',
      argv: ['workbench', 'resources', 'graph', ref, '--mode', 'lineage', '--json'],
    }),
    action({
      key: 'validate',
      label: 'Validate',
      enabled,
      reason: enabled ? undefined : 'Disabled or draft assets are not runtime-validatable.',
      argv: ['assets', 'validate', '--json'],
    }),
    action({
      key: 'duplicate',
      label: 'Duplicate',
      enabled,
      maturity: 'controlled-mutation',
      reason: enabled
        ? 'Duplicate/copy is routed through native MatOS project-local clone preview/apply gates.'
        : 'Disabled or draft assets cannot be duplicated from marketplace surfaces.',
      requiresConfirmation: true,
      argv: ['workbench', 'search', 'duplicate', ref, '--json'],
    }),
  ]

  if (sourceId) {
    actions.push(
      action({
        key: 'validate-source',
        label: 'Validate Source',
        argv: ['assets', 'sources', 'status', sourceId, '--json'],
      }),
      action({
        key: 'refresh-source',
        label: 'Refresh Source',
        argv: ['assets', 'sources', 'refresh', sourceId, '--json'],
        reason:
          'Refreshes the materialized Git/Gitea source cache through native MatOS source validation.',
      }),
      action({
        key: 'commit-source',
        label: 'Commit Source',
        maturity: 'controlled-mutation',
        requiresConfirmation: true,
        argv: [
          'assets',
          'git',
          'commit-source',
          sourceId,
          '--message',
          'MatOS asset source update',
          '--push',
          '--json',
        ],
        reason:
          'Commits and pushes pending changes in the materialized Git/Gitea source through native MatOS source governance.',
      }),
      action({
        key: 'accept-source',
        label: 'Accept Source',
        maturity: 'controlled-mutation',
        requiresConfirmation: true,
        argv: [
          'assets',
          'git',
          'accept',
          sourceId,
          '--channel',
          'stable',
          '--push',
          '--json',
        ],
        reason:
          'Validates the Gitea source commit and advances the MatOS accepted runtime ref.',
      }),
      action({
        key: 'rollback-source',
        label: 'Rollback Source',
        maturity: 'controlled-mutation',
        requiresConfirmation: true,
        argv: ['assets', 'git', 'rollback-pr', sourceId, '--json'],
        reason:
          'Creates a rollback pull request from the current accepted runtime ref.',
      }),
    )
  }

  if (asset.type === 'workflow') {
    actions.push(
      action({
        key: 'compile',
        label: 'Compile',
        enabled,
        reason: enabled ? undefined : 'Workflow is not enabled.',
        argv: ['workbench', 'workflows', 'compile', ref, '--json'],
      }),
      action({
        key: 'run',
        label: 'Run',
        enabled: canRunWorkflow(asset),
        maturity: 'controlled-mutation',
        reason: canRunWorkflow(asset)
          ? undefined
          : workflowKind(asset) === 'component'
            ? 'Component workflows must be imported or called by another workflow.'
            : 'Workflow is not enabled.',
        argv: ['workbench', 'workflows', 'run', ref, '--json'],
      }),
      action({
        key: 'debug',
        label: 'Debug',
        enabled,
        reason: enabled ? undefined : 'Workflow is not enabled.',
        argv: ['workbench', 'workflows', 'show', ref, '--json'],
      }),
    )
  }

  if (asset.type === 'role') {
    actions.push(
      action({
        key: 'compose',
        label: 'Compose',
        enabled,
        reason: enabled ? undefined : 'Role is not enabled.',
        argv: ['workbench', 'roles', 'compose', ref, '--json'],
      }),
      action({
        key: 'debug',
        label: 'Debug',
        enabled,
        maturity: 'controlled-mutation',
        reason: enabled ? undefined : 'Role is not enabled.',
        argv: ['run', '--role', ref, 'debug this role'],
      }),
      action({
        key: 'attach',
        label: 'Attach Resource',
        enabled,
        maturity: 'controlled-mutation',
        reason: enabled ? undefined : 'Role is not enabled.',
        argv: ['workbench', 'resources', 'invoke-action', ref, 'attach', '--payload-json', '{"assetRef":"<asset-ref>"}', '--json'],
      }),
      action({
        key: 'detach',
        label: 'Detach Resource',
        enabled,
        maturity: 'controlled-mutation',
        reason: enabled ? undefined : 'Role is not enabled.',
        argv: ['workbench', 'resources', 'invoke-action', ref, 'detach', '--payload-json', '{"assetRef":"<asset-ref>"}', '--json'],
      }),
    )
  }

  if (attachableToRole(asset)) {
    actions.push(
      action({
        key: 'attach',
        label: 'Attach To Role',
        enabled,
        maturity: 'controlled-mutation',
        reason: enabled ? undefined : 'Only enabled assets can be attached to roles.',
        argv: ['workbench', 'resources', 'invoke-action', ref, 'attach', '--payload-json', '{"targetRef":"<role-ref>"}', '--json'],
      }),
      action({
        key: 'detach',
        label: 'Detach From Role',
        enabled,
        maturity: 'controlled-mutation',
        reason: enabled ? undefined : 'Only enabled assets can be detached from roles.',
        argv: ['workbench', 'resources', 'invoke-action', ref, 'detach', '--payload-json', '{"targetRef":"<role-ref>"}', '--json'],
      }),
    )
  }

  if (asset.type === 'knowledge' || asset.type === 'data') {
    actions.push(
      action({
        key: 'retrieve',
        label: 'Retrieve',
        enabled,
        reason: enabled ? undefined : 'Resource is not enabled.',
        argv: ['workbench', 'knowledge', 'show', ref, '--json'],
      }),
    )
  }

  if (asset.type === 'experience' || asset.type === 'evolution-proposal') {
    actions.push(
      action({
        key: 'approve',
        label: 'Approve',
        enabled: false,
        reason: 'Shared promotion requires an explicit MatOS governance command.',
        requiresConfirmation: true,
        operatorReview: releaseOperatorReviewForAsset(asset, 'approve'),
      }),
      action({
        key: 'reject',
        label: 'Reject',
        enabled: false,
        reason: 'Use the evolution review surface once proposal governance is active.',
        operatorReview: releaseOperatorReviewForAsset(asset, 'reject'),
      }),
    )
  }

  if (asset.lifecycle.status === 'enabled') {
    actions.push(
      action({
        key: 'disable',
        label: 'Disable',
        maturity: 'controlled-mutation',
        danger: true,
        requiresConfirmation: true,
        argv: ['assets', 'disable', ref],
      }),
    )
  } else if (asset.lifecycle.status === 'disabled') {
    actions.push(
      action({
        key: 'enable',
        label: 'Enable',
        maturity: 'controlled-mutation',
        requiresConfirmation: true,
        argv: ['assets', 'enable', ref],
      }),
    )
  }

  if (asset.type !== 'experience' && asset.type !== 'evolution-proposal') {
    actions.push(
      action({
        key: 'publish',
        label: 'Publish',
        maturity: 'controlled-mutation',
        reason: 'Publish preview routes through MatOS asset-history release gates; apply requires the current confirmation fingerprint.',
        requiresConfirmation: true,
        argv: ['workbench', 'resources', 'invoke-action', ref, 'publish', '--json'],
        operatorReview: releaseOperatorReviewForAsset(asset, 'publish'),
      }),
      action({
        key: 'rollback',
        label: 'Rollback',
        maturity: 'controlled-mutation',
        reason: 'Rollback preview routes through MatOS asset-history release gates; apply requires a release id and the current confirmation fingerprint.',
        danger: true,
        requiresConfirmation: true,
        argv: ['workbench', 'resources', 'invoke-action', ref, 'rollback', '--json'],
        operatorReview: releaseOperatorReviewForAsset(asset, 'rollback'),
      }),
    )
  }

  return actions
}

export function buildMatOSWorkbenchRunActions(input: {
  runId: string
  status?: string
  waitingNodeId?: string
}): MatOSWorkbenchAction[] {
  const { runId, status, waitingNodeId } = input
  const terminal = status === 'completed' || status === 'failed' || status === 'cancelled'
  return [
    action({
      key: 'inspect',
      label: 'Inspect',
      argv: ['workbench', 'workflows', 'inspect', runId, '--json'],
    }),
    action({
      key: 'view-trace',
      label: 'Events',
      argv: ['workbench', 'workflows', 'events', runId, '--json'],
    }),
    action({
      key: 'respond',
      label: 'Respond',
      enabled: Boolean(waitingNodeId),
      maturity: 'controlled-mutation',
      reason: waitingNodeId ? undefined : 'No waiting node.',
      argv: ['workbench', 'workflows', 'respond', runId, '--node', waitingNodeId ?? '<node-id>', '--message', '<message>', '--json'],
    }),
    action({
      key: 'pause',
      label: 'Pause',
      enabled: !terminal && status !== 'paused',
      maturity: 'controlled-mutation',
      reason: terminal ? 'Run is terminal.' : status === 'paused' ? 'Run is already paused.' : undefined,
      argv: ['workbench', 'workflows', 'pause', runId, '--json'],
    }),
    action({
      key: 'resume',
      label: 'Resume',
      enabled: status === 'paused',
      maturity: 'controlled-mutation',
      reason: status === 'paused' ? undefined : 'Run is not paused.',
      argv: ['workbench', 'workflows', 'resume', runId, '--json'],
    }),
    action({
      key: 'cancel',
      label: 'Cancel',
      enabled: !terminal,
      maturity: 'controlled-mutation',
      reason: terminal ? 'Run is already terminal.' : undefined,
      danger: true,
      requiresConfirmation: true,
      argv: ['workbench', 'workflows', 'cancel', runId, '--json'],
    }),
    action({
      key: 'recover',
      label: 'Recover (classify)',
      enabled: status !== 'completed',
      reason: status === 'completed' ? 'Run completed normally.' : undefined,
      argv: ['workbench', 'workflows', 'recover', runId, '--json'],
    }),
    action({
      key: 'recover-apply',
      label: 'Apply recovery',
      enabled: status !== 'completed',
      maturity: 'controlled-mutation',
      reason: status === 'completed' ? 'Run completed normally.' : undefined,
      argv: ['workbench', 'workflows', 'recover-apply', runId, '--json'],
    }),
    action({
      key: 'reconcile',
      label: 'Reconcile remote jobs',
      enabled: !terminal || status === 'failed',
      maturity: 'controlled-mutation',
      reason:
        !terminal || status === 'failed'
          ? undefined
          : 'Run is terminal without remote reconcile targets.',
      argv: ['workbench', 'workflows', 'reconcile', runId, '--json'],
    }),
  ]
}

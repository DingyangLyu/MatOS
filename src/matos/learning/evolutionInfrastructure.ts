/** Infrastructure failures are not evidence that an editing algorithm failed.
 * Keep this deterministic and return codes only, never credentials/raw logs. */
export function evolutionInfrastructureFailureCode(input: {
  statusReason?: string
  sourceCommitErrors?: { error: string }[]
  error?: string
}): string | undefined {
  if (input.statusReason?.startsWith('gitea_')) return input.statusReason
  if (['direct_editor_writable_root_unavailable', 'direct_editor_scoped_source_unavailable'].includes(input.statusReason ?? '')) return input.statusReason
  const text = [input.error, ...(input.sourceCommitErrors ?? []).map(item => item.error)].filter(Boolean).join('\n')
  if (/gitea_(credentials_missing|auth_rejected|identity_mismatch|repository_forbidden|unavailable|source_invalid|version_stale|source_config_conflict)/.test(text)) return text.match(/gitea_[a-z_]+/)![0]
  if (/Authentication failed|could not read Username|HTTP (?:401|403)|access denied|requires MATOS_GITEA_TOKEN/i.test(text)) return 'gitea_auth_rejected'
  if (/EACCES|EPERM|ENOSPC|disk quota|unable to write new index|cannot lock ref|index\.lock|permission denied/i.test(text)) return 'gitea_storage_unavailable'
  if (/non.fast.forward|force-with-lease|stale info|current remote accepted|accepted-ref verification failed/i.test(text)) return 'gitea_version_stale'
  if ((input.sourceCommitErrors?.length || /Gitea|git (?:fetch|push|clone|transport)/i.test(text)) &&
    /Could not resolve host|Connection refused|timed out|ECONN|ENOTFOUND|HTTP (?:429|5\d\d)/i.test(text)) return 'gitea_unavailable'
  return undefined
}

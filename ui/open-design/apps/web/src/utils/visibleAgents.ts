import type { AgentInfo } from '../types';

// Behind the MatOS gateway the runtime is the native MatOS CLI; the other
// vendored coding-CLI brands (Cursor, Codex, Gemini, Claude, ...) are
// irrelevant to a MatOS workspace and their logos read as foreign branding.
// `amr` stays because the product renames it to "MatOS" account surfaces.
const MATOS_GATEWAY_AGENT_IDS = new Set(['matos', 'amr']);

export function isVisibleLocalCliAgent(
  agent: Pick<AgentInfo, 'id'>,
  options: { matosGateway?: boolean } = {},
): boolean {
  if (options.matosGateway) return MATOS_GATEWAY_AGENT_IDS.has(agent.id);
  return true;
}


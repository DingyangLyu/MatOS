import type { AgentInfo, AgentModelChoice } from '../types';

type AgentModelSource = Pick<AgentInfo, 'id' | 'models'> | null | undefined;

export function normalizeAgentModelChoice(
  agent: AgentModelSource,
  choice: AgentModelChoice | undefined,
): AgentModelChoice | null {
  return null;
}

export function effectiveAgentModelChoice(
  agent: AgentModelSource,
  choice: AgentModelChoice | undefined,
): AgentModelChoice | undefined {
  return normalizeAgentModelChoice(agent, choice) ?? choice;
}

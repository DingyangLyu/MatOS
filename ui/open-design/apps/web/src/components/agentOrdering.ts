export function orderAgentsWithOpenDesignFirst<T extends { id: string }>(
  agents: readonly T[],
): T[] {
  const openDesignAgents: T[] = [];
  const otherAgents: T[] = [];
  for (const agent of agents) {
    otherAgents.push(agent);
  }
  return [...openDesignAgents, ...otherAgents];
}

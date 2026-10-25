export class WorkflowDocumentConflict extends Error {}

export async function readWorkflowFile(
  projectId: string,
  name: string,
): Promise<{ text: string; revision: string }> {
  const response = await fetch(
    `/api/projects/${encodeURIComponent(projectId)}/files/${name.split('/').map(encodeURIComponent).join('/')}`,
    { cache: 'no-store' },
  );
  if (!response.ok) throw new Error(`Read failed (${response.status})`);
  const revision = response.headers.get('X-MatOS-File-Revision');
  if (!revision)
    throw new Error('File revision is unavailable; reload after updating the workspace service');
  return { text: await response.text(), revision };
}

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const equal = (left: unknown, right: unknown): boolean => {
  if (object(left) && object(right)) {
    const keys = Object.keys(left);
    return (
      keys.length === Object.keys(right).length &&
      keys.every((key) => Object.hasOwn(right, key) && equal(left[key], right[key]))
    );
  }
  return JSON.stringify(left) === JSON.stringify(right);
};

/** Merge independent edits; arrays are atomic except workflow nodes keyed by id. */
export function mergeWorkflowDocuments(
  baseText: string,
  localText: string,
  remoteText: string,
): { text: string; conflicts: string[] } {
  const conflicts: string[] = [];
  const merge = (base: unknown, local: unknown, remote: unknown, path: string): unknown => {
    if (equal(local, remote) || equal(remote, base)) return local;
    if (equal(local, base)) return remote;
    if (object(base) && object(local) && object(remote)) {
      const result: Record<string, unknown> = {};
      for (const key of new Set([
        ...Object.keys(base),
        ...Object.keys(local),
        ...Object.keys(remote),
      ])) {
        const value = merge(base[key], local[key], remote[key], `${path}/${key}`);
        if (value !== undefined)
          Object.defineProperty(result, key, {
            value,
            enumerable: true,
            writable: true,
            configurable: true,
          });
      }
      return result;
    }
    if (
      path === '/nodes' &&
      [base, local, remote].every(
        (value) =>
          Array.isArray(value) &&
          value.every((node) => object(node) && typeof node.id === 'string') &&
          new Set(value.map((node) => node.id)).size === value.length,
      )
    ) {
      const arrays = [base, local, remote] as Array<Array<Record<string, unknown>>>;
      const maps = arrays.map((nodes) => new Map(nodes.map((node) => [node.id, node])));
      return [...new Set([...maps[1]!.keys(), ...maps[2]!.keys()])]
        .map((id) => merge(maps[0]!.get(id), maps[1]!.get(id), maps[2]!.get(id), `${path}/${id}`))
        .filter((node) => node !== undefined);
    }
    conflicts.push(path || '/');
    return local;
  };
  return {
    text: JSON.stringify(
      merge(JSON.parse(baseText), JSON.parse(localText), JSON.parse(remoteText), ''),
      null,
      2,
    ),
    conflicts,
  };
}

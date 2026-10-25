// MatOS workflow document model for the Workflow Studio canvas tab.
//
// A `*.workflow.json` project file holds a native MatOS workflow definition
// (schemaVersion 1): nodes with `dependsOn` ordering, optional conditioned
// `edges`, parameters/outputs maps, and a `canvas.nodes` position map that is
// pure UI state. The canvas editor and the MatOS agent (e.g.
// role:workflow-builder) edit the same file — the agent through its normal
// Write/Edit tools, the human through the React Flow canvas — so parsing here
// must be tolerant and serialization must round-trip every field we do not
// explicitly model.

export const WORKFLOW_FILE_SUFFIX = '.workflow.json';

export function isWorkflowJsonFileName(name: string): boolean {
  return name.toLowerCase().endsWith(WORKFLOW_FILE_SUFFIX);
}

/** `<name>.workflow.yaml` / `.yml`, or a bare asset-entry `workflow.yaml`. */
export function isWorkflowYamlFileName(name: string): boolean {
  const lower = name.toLowerCase();
  const base = lower.split('/').pop() ?? lower;
  return (
    lower.endsWith('.workflow.yaml') ||
    lower.endsWith('.workflow.yml') ||
    base === 'workflow.yaml' ||
    base === 'workflow.yml'
  );
}

/**
 * Every file the Workflow Studio canvas should open: JSON project drafts
 * (`*.workflow.json`), YAML definitions (`*.workflow.yaml|yml`), and bare
 * asset entry files (`workflow.json` / `workflow.yaml` — the native workflow
 * asset layout). Mirrors the daemon's `kindFor` workflow bucket.
 */
export function isWorkflowFileName(name: string): boolean {
  const lower = name.toLowerCase();
  const base = lower.split('/').pop() ?? lower;
  return isWorkflowJsonFileName(lower) || isWorkflowYamlFileName(lower) || base === 'workflow.json';
}

/** Published native snapshots belong in the asset library, not draft links. */
export function isWorkflowDraftFileName(name: string): boolean {
  return isWorkflowFileName(name) && !name.replaceAll('\\', '/').split('/').includes('.matos');
}

export function workflowReferenceLabel(ref: string | null): string {
  if (!ref) return '-';
  // Only remove the bridge's document/revision suffix when its immutable
  // canvas version carries the same revision. Other asset IDs stay intact.
  const canvas = /^workflow:(.+)-[a-f0-9]{12}-([a-f0-9]{16})@0\.1\.0-canvas\.\2$/.exec(ref);
  return canvas?.[1] ?? ref.replace(/^workflow:/, '').replace(/@.*$/, '');
}

/** Strip the workflow suffix/extension for canvas fallback names. */
export function workflowFallbackName(name: string): string {
  const base = name.split('/').pop() ?? name;
  return base.replace(/\.workflow\.(json|ya?ml)$/i, '').replace(/\.(json|ya?ml)$/i, '');
}

// Node types mirror the native MatOS workflow node manifests. `agent` mounts a
// role asset; the rest stay generic per the MatOS workflow foundation rules.
export const WORKFLOW_NODE_TYPES = [
  'agent',
  'exec',
  'compute',
  'validate',
  'guard',
  'human',
  'approval_gate',
  'backend',
  'subworkflow',
  'map',
  'loop',
  'dynamic',
] as const;

export interface WorkflowNodeRecord {
  id: string;
  type: string;
  dependsOn: string[];
  /** Display name shown on the canvas; the id stays the wiring identity. */
  label?: string;
  description?: string;
  role?: string;
  prompt?: string;
  command?: string;
  workflow?: string;
  [key: string]: unknown;
}

export interface WorkflowEdgeRecord {
  from: string;
  to: string;
  condition?: string;
  route?: 'success' | 'failure' | 'always';
  [key: string]: unknown;
}

export interface WorkflowCanvasPositions {
  [nodeId: string]: { x: number; y: number };
}

/**
 * Per-node canvas presentation overrides (pure UI state, like positions).
 * `accent` is a CSS color that replaces the node type's default accent.
 */
export interface WorkflowCanvasStyles {
  [nodeId: string]: { accent?: string };
}

export interface WorkflowDefinitionRecord {
  schemaVersion: number;
  name: string;
  version?: string;
  description?: string;
  parameters: Record<string, unknown>;
  policy: Record<string, unknown>;
  nodes: WorkflowNodeRecord[];
  edges?: WorkflowEdgeRecord[];
  transitions?: Array<Record<string, unknown>>;
  outputs: Record<string, unknown>;
  canvas?: {
    nodes?: WorkflowCanvasPositions;
    styles?: WorkflowCanvasStyles;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface ParsedWorkflowDocument {
  definition: WorkflowDefinitionRecord;
  /** Non-null when the file content was not a readable workflow document. */
  parseError: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

export function emptyWorkflowDefinition(name: string): WorkflowDefinitionRecord {
  return {
    schemaVersion: 1,
    name,
    version: '0.1.0',
    description: '',
    parameters: {},
    policy: { approvalMode: 'bypass' },
    nodes: [],
    outputs: {},
    canvas: { nodes: {} },
  };
}

function normalizeNode(raw: unknown, index: number): WorkflowNodeRecord | null {
  if (!isRecord(raw)) return null;
  const id = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : `node_${index + 1}`;
  const type = typeof raw.type === 'string' && raw.type.trim() ? raw.type.trim() : 'exec';
  return {
    ...raw,
    id,
    type,
    dependsOn: asStringArray(raw.dependsOn),
  } as WorkflowNodeRecord;
}

function normalizeEdge(raw: unknown): WorkflowEdgeRecord | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.from !== 'string' || typeof raw.to !== 'string') return null;
  return raw as unknown as WorkflowEdgeRecord;
}

export function parseWorkflowDocument(text: string, fallbackName: string): ParsedWorkflowDocument {
  const trimmed = text.trim();
  if (!trimmed) {
    return { definition: emptyWorkflowDefinition(fallbackName), parseError: null };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch (err) {
    return {
      definition: emptyWorkflowDefinition(fallbackName),
      parseError: err instanceof Error ? err.message : String(err),
    };
  }
  if (!isRecord(raw)) {
    return {
      definition: emptyWorkflowDefinition(fallbackName),
      parseError: 'workflow document is not a JSON object',
    };
  }
  // The native schema accepts nodes as either an array (each entry carrying
  // its own `id`) or a map keyed by node id. Normalize both to the array
  // form the canvas uses; map keys win over any inner `id` field, matching
  // the native normalizeNodes behavior.
  const rawNodeEntries: unknown[] = Array.isArray(raw.nodes)
    ? raw.nodes
    : isRecord(raw.nodes)
      ? Object.entries(raw.nodes).map(([id, node]) => (isRecord(node) ? { ...node, id } : { id }))
      : [];
  const nodes = rawNodeEntries
    .map((node, index) => normalizeNode(node, index))
    .filter((node): node is WorkflowNodeRecord => node !== null);
  const edges = Array.isArray(raw.edges)
    ? raw.edges.map(normalizeEdge).filter((edge): edge is WorkflowEdgeRecord => edge !== null)
    : undefined;
  const canvasRaw = isRecord(raw.canvas) ? raw.canvas : undefined;
  const canvasNodes: WorkflowCanvasPositions = {};
  if (canvasRaw && isRecord(canvasRaw.nodes)) {
    for (const [nodeId, pos] of Object.entries(canvasRaw.nodes)) {
      if (isRecord(pos) && typeof pos.x === 'number' && typeof pos.y === 'number') {
        canvasNodes[nodeId] = { x: pos.x, y: pos.y };
      }
    }
  }
  const canvasStyles: WorkflowCanvasStyles = {};
  if (canvasRaw && isRecord(canvasRaw.styles)) {
    for (const [nodeId, style] of Object.entries(canvasRaw.styles)) {
      if (isRecord(style) && typeof style.accent === 'string' && style.accent.trim()) {
        canvasStyles[nodeId] = { accent: style.accent };
      }
    }
  }
  const definition: WorkflowDefinitionRecord = {
    ...raw,
    schemaVersion: typeof raw.schemaVersion === 'number' ? raw.schemaVersion : 1,
    name: typeof raw.name === 'string' && raw.name.trim() ? raw.name : fallbackName,
    parameters: isRecord(raw.parameters) ? raw.parameters : {},
    policy: isRecord(raw.policy) ? raw.policy : { approvalMode: 'bypass' },
    nodes,
    ...(edges ? { edges } : {}),
    outputs: isRecord(raw.outputs) ? raw.outputs : {},
    canvas: { ...(canvasRaw ?? {}), nodes: canvasNodes, styles: canvasStyles },
  };
  return { definition, parseError: null };
}

export function serializeWorkflowDocument(definition: WorkflowDefinitionRecord): string {
  // Keep files diff-clean: drop an empty `styles` map (workflows that never
  // used per-node colors should not gain the key on save).
  const canvas = definition.canvas;
  if (canvas && isRecord(canvas.styles) && Object.keys(canvas.styles).length === 0) {
    const { styles: _styles, ...rest } = canvas;
    definition = { ...definition, canvas: rest };
  }
  return `${JSON.stringify(definition, null, 2)}\n`;
}

/**
 * The canvas edge list: explicit `edges` entries plus plain ordering edges
 * derived from each node's `dependsOn` that are not already covered by an
 * explicit edge. `explicit` marks edges that carry condition/route metadata
 * (or came from the definition's `edges` array) so saves can keep plain
 * ordering in `dependsOn` and avoid rewriting assets that never used `edges`.
 */
export interface CanvasEdge {
  from: string;
  to: string;
  explicit: boolean;
  record?: WorkflowEdgeRecord;
}

export function canvasEdgesFromDefinition(definition: WorkflowDefinitionRecord): CanvasEdge[] {
  const out: CanvasEdge[] = [];
  const seen = new Set<string>();
  for (const edge of definition.edges ?? []) {
    const key = `${edge.from}\u0000${edge.to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ from: edge.from, to: edge.to, explicit: true, record: edge });
  }
  for (const node of definition.nodes) {
    for (const dep of node.dependsOn) {
      const key = `${dep}\u0000${node.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ from: dep, to: node.id, explicit: false });
    }
  }
  return out;
}

/**
 * Write the canvas edge list back into the definition: every node's
 * `dependsOn` becomes the sources of its incoming canvas edges (stable order),
 * and only edges marked explicit (condition/route metadata) are kept in the
 * `edges` array. Dropping `edges` entirely when none are explicit keeps
 * dependsOn-only workflow assets diff-clean.
 */
export function applyCanvasEdgesToDefinition(
  definition: WorkflowDefinitionRecord,
  edges: CanvasEdge[],
): WorkflowDefinitionRecord {
  const incoming = new Map<string, string[]>();
  for (const edge of edges) {
    const list = incoming.get(edge.to) ?? [];
    if (!list.includes(edge.from)) list.push(edge.from);
    incoming.set(edge.to, list);
  }
  const nodes = definition.nodes.map((node) => ({
    ...node,
    dependsOn: incoming.get(node.id) ?? [],
  }));
  const explicitEdges = edges
    .filter((edge) => edge.explicit)
    .map((edge) => ({ ...(edge.record ?? {}), from: edge.from, to: edge.to }));
  const next: WorkflowDefinitionRecord = { ...definition, nodes };
  if (explicitEdges.length > 0) {
    next.edges = explicitEdges as WorkflowEdgeRecord[];
  } else {
    delete next.edges;
  }
  return next;
}

export function uniqueWorkflowNodeId(definition: WorkflowDefinitionRecord, base: string): string {
  const taken = new Set(definition.nodes.map((node) => node.id));
  const slug = base.replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '') || 'node';
  if (!taken.has(slug)) return slug;
  let index = 2;
  while (taken.has(`${slug}_${index}`)) index += 1;
  return `${slug}_${index}`;
}

/**
 * Deterministic layered fallback layout for nodes without stored canvas
 * positions: topological depth → column, order within layer → row.
 */
export function autoLayoutPositions(
  nodes: WorkflowNodeRecord[],
  edges: CanvasEdge[],
): WorkflowCanvasPositions {
  const depths = new Map<string, number>();
  const incoming = new Map<string, string[]>();
  for (const node of nodes) incoming.set(node.id, []);
  for (const edge of edges) {
    if (incoming.has(edge.to) && incoming.has(edge.from)) {
      incoming.get(edge.to)!.push(edge.from);
    }
  }
  const depthOf = (id: string, trail: Set<string>): number => {
    const cached = depths.get(id);
    if (cached !== undefined) return cached;
    if (trail.has(id)) return 0;
    trail.add(id);
    const parents = incoming.get(id) ?? [];
    const depth = parents.length === 0 ? 0 : Math.max(...parents.map((p) => depthOf(p, trail))) + 1;
    depths.set(id, depth);
    return depth;
  };
  const rows = new Map<number, number>();
  const positions: WorkflowCanvasPositions = {};
  for (const node of nodes) {
    const depth = depthOf(node.id, new Set());
    const row = rows.get(depth) ?? 0;
    rows.set(depth, row + 1);
    positions[node.id] = { x: 60 + depth * 300, y: 60 + row * 140 };
  }
  return positions;
}

/** Rename a node and remap every dependsOn/edge reference to it. */
export function rewriteWorkflowReferences<T>(value: T, collection: 'nodes' | 'parameters', from: string, to: string): T {
  const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const reference = new RegExp(`\\b${collection}\\.${escaped}(?=[.\\[\\s}()+*/<>=!?:,-]|$)`, 'g');
  const visit = (entry: unknown): unknown => {
    if (typeof entry === 'string') return entry.replace(/\{\{([\s\S]*?)\}\}/g, (_, expression: string) => {
      // Quoted literals in expressions are data, not node/parameter references.
      const rewritten = expression.replace(/("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|([^"']+)/g, (part, quoted: string | undefined) => quoted ? part : part.replace(reference, `${collection}.${to}`));
      return `{{${rewritten}}}`;
    });
    if (Array.isArray(entry)) return entry.map(visit);
    if (entry && typeof entry === 'object') return Object.fromEntries(Object.entries(entry).map(([key, child]) => [key, visit(child)]));
    return entry;
  };
  return visit(value) as T;
}

export function renameWorkflowNode(
  definition: WorkflowDefinitionRecord,
  fromId: string,
  toId: string,
): WorkflowDefinitionRecord {
  definition = rewriteWorkflowReferences(definition, 'nodes', fromId, toId);
  const nodes = definition.nodes.map((node) => ({
    ...node,
    id: node.id === fromId ? toId : node.id,
    dependsOn: node.dependsOn.map((dep) => (dep === fromId ? toId : dep)),
    ...(Array.isArray(node.checks) ? { checks: node.checks.map((check) => isRecord(check) && check.sourceNodeId === fromId ? { ...check, sourceNodeId: toId } : check) } : {}),
  }));
  const edges = definition.edges?.map((edge) => ({
    ...edge,
    from: edge.from === fromId ? toId : edge.from,
    to: edge.to === fromId ? toId : edge.to,
  }));
  const canvasNodes = { ...(definition.canvas?.nodes ?? {}) };
  if (canvasNodes[fromId]) {
    canvasNodes[toId] = canvasNodes[fromId];
    delete canvasNodes[fromId];
  }
  const canvasStyles = { ...(definition.canvas?.styles ?? {}) };
  if (canvasStyles[fromId]) {
    canvasStyles[toId] = canvasStyles[fromId];
    delete canvasStyles[fromId];
  }
  return {
    ...definition,
    nodes,
    ...(edges ? { edges } : {}),
    ...(definition.transitions ? { transitions: definition.transitions.map((transition) => ({ ...transition, from: transition.from === fromId ? toId : transition.from, to: transition.to === fromId ? toId : transition.to })) } : {}),
    canvas: { ...(definition.canvas ?? {}), nodes: canvasNodes, styles: canvasStyles },
  };
}

/** Remove a node plus every edge/dependsOn/canvas reference to it. */
export function removeWorkflowNode(
  definition: WorkflowDefinitionRecord,
  nodeId: string,
): WorkflowDefinitionRecord {
  const nodes = definition.nodes
    .filter((node) => node.id !== nodeId)
    .map((node) => ({
      ...node,
      dependsOn: node.dependsOn.filter((dep) => dep !== nodeId),
    }));
  const edges = definition.edges?.filter((edge) => edge.from !== nodeId && edge.to !== nodeId);
  const canvasNodes = { ...(definition.canvas?.nodes ?? {}) };
  delete canvasNodes[nodeId];
  const canvasStyles = { ...(definition.canvas?.styles ?? {}) };
  delete canvasStyles[nodeId];
  const next: WorkflowDefinitionRecord = {
    ...definition,
    nodes,
    canvas: { ...(definition.canvas ?? {}), nodes: canvasNodes, styles: canvasStyles },
  };
  if (edges && edges.length > 0) next.edges = edges;
  else delete next.edges;
  return next;
}

/**
 * Duplicate a node: same config (minus wiring), fresh unique id, no incoming/
 * outgoing edges. Returns the new node id so the canvas can select/place it.
 */
export function duplicateWorkflowNode(
  definition: WorkflowDefinitionRecord,
  nodeId: string,
): { definition: WorkflowDefinitionRecord; newId: string } | null {
  const source = definition.nodes.find((node) => node.id === nodeId);
  if (!source) return null;
  const newId = uniqueWorkflowNodeId(definition, `${source.id}_copy`);
  const copy: WorkflowNodeRecord = { ...source, id: newId, dependsOn: [] };
  const canvasStyles = { ...(definition.canvas?.styles ?? {}) };
  if (canvasStyles[nodeId]) canvasStyles[newId] = { ...canvasStyles[nodeId] };
  return {
    definition: {
      ...definition,
      nodes: [...definition.nodes, copy],
      canvas: { ...(definition.canvas ?? {}), styles: canvasStyles },
    },
    newId,
  };
}

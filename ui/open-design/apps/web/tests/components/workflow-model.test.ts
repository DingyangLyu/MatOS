import { describe, expect, it } from 'vitest';
import {
  applyCanvasEdgesToDefinition,
  autoLayoutPositions,
  canvasEdgesFromDefinition,
  duplicateWorkflowNode,
  emptyWorkflowDefinition,
  isWorkflowFileName,
  isWorkflowJsonFileName,
  isWorkflowYamlFileName,
  parseWorkflowDocument,
  removeWorkflowNode,
  renameWorkflowNode,
  serializeWorkflowDocument,
  uniqueWorkflowNodeId,
  workflowFallbackName,
} from '../../src/components/workflow-model';

const SAMPLE = JSON.stringify({
  schemaVersion: 1,
  name: 'demo',
  version: '1.0.0',
  parameters: { input: { type: 'string', default: 'x' } },
  policy: { approvalMode: 'bypass' },
  nodes: [
    { id: 'plan', type: 'agent', role: 'role:workflow-planner', dependsOn: [] },
    { id: 'run', type: 'exec', command: 'echo hi', dependsOn: ['plan'] },
    { id: 'check', type: 'validate', dependsOn: ['run'], checks: [{ type: 'file_exists', path: 'out.txt' }] },
  ],
  edges: [{ from: 'run', to: 'check', route: 'success' }],
  outputs: { result: { from: 'check' } },
  customTopLevel: { keep: true },
});

describe('workflow-model', () => {
  it('detects workflow file names case-insensitively', () => {
    expect(isWorkflowJsonFileName('a.workflow.json')).toBe(true);
    expect(isWorkflowJsonFileName('A.WORKFLOW.JSON')).toBe(true);
    expect(isWorkflowJsonFileName('a.sketch.json')).toBe(false);
    expect(isWorkflowJsonFileName('workflow.json5')).toBe(false);
  });

  it('detects project and native asset workflow JSON/YAML entries', () => {
    expect(isWorkflowFileName('a.workflow.json')).toBe(true);
    expect(isWorkflowFileName('a.workflow.yaml')).toBe(true);
    expect(isWorkflowFileName('A.WORKFLOW.YML')).toBe(true);
    expect(isWorkflowFileName('packs/a/workflow.json')).toBe(true);
    expect(isWorkflowFileName('packs/a/workflow.yaml')).toBe(true);
    expect(isWorkflowYamlFileName('packs/a/workflow.yml')).toBe(true);
    expect(isWorkflowFileName('ordinary.yaml')).toBe(false);
    expect(isWorkflowFileName('workflow.json5')).toBe(false);
  });

  it('derives readable fallback names from workflow entry paths', () => {
    expect(workflowFallbackName('nested/relax.workflow.yaml')).toBe('relax');
    expect(workflowFallbackName('nested/workflow.json')).toBe('workflow');
  });

  it('parses a definition and preserves unknown fields through round-trip', () => {
    const { definition, parseError } = parseWorkflowDocument(SAMPLE, 'fallback');
    expect(parseError).toBeNull();
    expect(definition.name).toBe('demo');
    expect(definition.nodes).toHaveLength(3);
    const roundTrip = JSON.parse(serializeWorkflowDocument(definition));
    expect(roundTrip.customTopLevel).toEqual({ keep: true });
    expect(roundTrip.nodes[2].checks).toEqual([{ type: 'file_exists', path: 'out.txt' }]);
    expect(roundTrip.parameters.input.default).toBe('x');
  });

  it('reports parse errors and falls back to an empty definition', () => {
    const { definition, parseError } = parseWorkflowDocument('not json {', 'fallback');
    expect(parseError).not.toBeNull();
    expect(definition.name).toBe('fallback');
    expect(definition.nodes).toHaveLength(0);
  });

  it('derives canvas edges from dependsOn plus explicit edges without duplicates', () => {
    const { definition } = parseWorkflowDocument(SAMPLE, 'demo');
    const edges = canvasEdgesFromDefinition(definition);
    expect(edges).toHaveLength(2);
    const explicit = edges.find((edge) => edge.from === 'run' && edge.to === 'check');
    expect(explicit?.explicit).toBe(true);
    expect(explicit?.record?.route).toBe('success');
    const implicit = edges.find((edge) => edge.from === 'plan' && edge.to === 'run');
    expect(implicit?.explicit).toBe(false);
  });

  it('writes canvas edges back into dependsOn and keeps only explicit edges', () => {
    const { definition } = parseWorkflowDocument(SAMPLE, 'demo');
    const edges = canvasEdgesFromDefinition(definition);
    // Add a new plain edge plan -> check drawn on the canvas.
    edges.push({ from: 'plan', to: 'check', explicit: false });
    const next = applyCanvasEdgesToDefinition(definition, edges);
    const check = next.nodes.find((node) => node.id === 'check');
    expect(check?.dependsOn.sort()).toEqual(['plan', 'run']);
    expect(next.edges).toHaveLength(1);
    expect(next.edges?.[0]).toMatchObject({ from: 'run', to: 'check', route: 'success' });
  });

  it('drops the edges array entirely when no explicit edges remain', () => {
    const definition = emptyWorkflowDefinition('t');
    definition.nodes = [
      { id: 'a', type: 'exec', dependsOn: [] },
      { id: 'b', type: 'exec', dependsOn: [] },
    ];
    const next = applyCanvasEdgesToDefinition(definition, [{ from: 'a', to: 'b', explicit: false }]);
    expect(next.nodes.find((node) => node.id === 'b')?.dependsOn).toEqual(['a']);
    expect(next.edges).toBeUndefined();
  });

  it('renames a node and remaps dependsOn, edges, and canvas positions', () => {
    const { definition } = parseWorkflowDocument(SAMPLE, 'demo');
    definition.canvas = { nodes: { run: { x: 10, y: 20 } } };
    const next = renameWorkflowNode(definition, 'run', 'execute');
    expect(next.nodes.map((node) => node.id)).toEqual(['plan', 'execute', 'check']);
    expect(next.nodes.find((node) => node.id === 'check')?.dependsOn).toEqual(['execute']);
    expect(next.edges?.[0]?.from).toBe('execute');
    expect(next.canvas?.nodes?.execute).toEqual({ x: 10, y: 20 });
  });

  it('removes a node plus every reference to it', () => {
    const { definition } = parseWorkflowDocument(SAMPLE, 'demo');
    const next = removeWorkflowNode(definition, 'run');
    expect(next.nodes.map((node) => node.id)).toEqual(['plan', 'check']);
    expect(next.nodes.find((node) => node.id === 'check')?.dependsOn).toEqual([]);
    expect(next.edges).toBeUndefined();
  });

  it('generates unique node ids', () => {
    const { definition } = parseWorkflowDocument(SAMPLE, 'demo');
    expect(uniqueWorkflowNodeId(definition, 'agent')).toBe('agent');
    expect(uniqueWorkflowNodeId(definition, 'plan')).toBe('plan_2');
  });

  it('lays out nodes left-to-right by topological depth', () => {
    const { definition } = parseWorkflowDocument(SAMPLE, 'demo');
    const positions = autoLayoutPositions(definition.nodes, canvasEdgesFromDefinition(definition));
    expect(positions.plan!.x).toBeLessThan(positions.run!.x);
    expect(positions.run!.x).toBeLessThan(positions.check!.x);
  });

  it('round-trips node labels and canvas styles, remapping them on rename', () => {
    const withStyle = JSON.stringify({
      ...JSON.parse(SAMPLE),
      nodes: [
        { id: 'plan', type: 'agent', label: '规划', dependsOn: [] },
        { id: 'run', type: 'exec', command: 'echo hi', dependsOn: ['plan'] },
      ],
      canvas: { nodes: { plan: { x: 1, y: 2 } }, styles: { plan: { accent: '#ff0000' } } },
    });
    const { definition } = parseWorkflowDocument(withStyle, 'demo');
    expect(definition.nodes[0]?.label).toBe('规划');
    expect(definition.canvas?.styles?.plan).toEqual({ accent: '#ff0000' });
    const renamed = renameWorkflowNode(definition, 'plan', 'plan2');
    expect(renamed.canvas?.styles?.plan2).toEqual({ accent: '#ff0000' });
    expect(renamed.canvas?.styles?.plan).toBeUndefined();
    const removed = removeWorkflowNode(renamed, 'plan2');
    expect(removed.canvas?.styles?.plan2).toBeUndefined();
    const roundTrip = JSON.parse(serializeWorkflowDocument(renamed));
    expect(roundTrip.canvas.styles.plan2).toEqual({ accent: '#ff0000' });
    expect(roundTrip.nodes[0].label).toBe('规划');
  });

  it('drops an empty styles map on serialize to keep untouched files diff-clean', () => {
    const { definition } = parseWorkflowDocument(SAMPLE, 'demo');
    const roundTrip = JSON.parse(serializeWorkflowDocument(definition));
    expect(roundTrip.canvas.styles).toBeUndefined();
  });

  it('duplicates a node with a fresh id and no wiring', () => {
    const { definition } = parseWorkflowDocument(SAMPLE, 'demo');
    definition.canvas = { nodes: {}, styles: { run: { accent: '#123456' } } };
    const result = duplicateWorkflowNode(definition, 'run');
    expect(result).not.toBeNull();
    expect(result!.newId).toBe('run_copy');
    const copy = result!.definition.nodes.find((node) => node.id === 'run_copy');
    expect(copy?.command).toBe('echo hi');
    expect(copy?.dependsOn).toEqual([]);
    expect(result!.definition.canvas?.styles?.run_copy).toEqual({ accent: '#123456' });
    // No edges point at the copy.
    const edges = canvasEdgesFromDefinition(result!.definition);
    expect(edges.some((edge) => edge.to === 'run_copy' || edge.from === 'run_copy')).toBe(false);
  });
});

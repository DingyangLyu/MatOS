import { describe, expect, it } from 'vitest';
import { mergeWorkflowDocuments } from '../../src/components/workflow-document';
import { parseWorkflowParameters } from '../../src/components/WorkflowForms';
import {
  emptyWorkflowDefinition,
  renameWorkflowNode,
  rewriteWorkflowReferences,
} from '../../src/components/workflow-model';

describe('workflow collaboration', () => {
  it('renames expression references and transitions without changing literal prose', () => {
    const definition = {
      ...emptyWorkflowDefinition('test'),
      nodes: [
        { id: 'a', type: 'exec', dependsOn: [], command: 'echo a' },
        {
          id: 'b',
          type: 'guard',
          dependsOn: ['a'],
          checks: [
            { type: 'numeric_range', value: '{{ nodes.a.outputs.exitCode }}', sourceNodeId: 'a' },
          ],
        },
      ],
      outputs: { result: { value: '{{ nodes.a.outputs.stdout }}' } },
      transitions: [{ from: 'a', to: 'b' }],
    };
    const next = renameWorkflowNode(definition, 'a', 'renamed');
    expect(next.outputs.result).toEqual({ value: '{{ nodes.renamed.outputs.stdout }}' });
    expect(next.transitions?.[0]?.from).toBe('renamed');
    expect(next.nodes[1]?.dependsOn).toEqual(['renamed']);
    expect(
      rewriteWorkflowReferences(
        'nodes.a {{ "nodes.a" }} {{ nodes.abc.outputs.x }} {{ nodes.a.outputs.x + 1 }}',
        'nodes',
        'a',
        'z',
      ),
    ).toBe('nodes.a {{ "nodes.a" }} {{ nodes.abc.outputs.x }} {{ nodes.z.outputs.x + 1 }}');
  });
  const base = {
    name: 'test',
    nodes: [
      { id: 'a', command: 'a' },
      { id: 'b', command: 'b' },
    ],
    policy: { maxParallel: 1 },
  };
  const merge = (local: unknown, remote: unknown) =>
    mergeWorkflowDocuments(JSON.stringify(base), JSON.stringify(local), JSON.stringify(remote));
  it('merges separate node changes and preserves unknown fields', () => {
    const result = merge(
      { ...base, nodes: [{ id: 'a', command: 'local', extra: 1 }, base.nodes[1]] },
      {
        ...base,
        nodes: [base.nodes[0], { id: 'b', command: 'remote' }],
        policy: { maxParallel: 4 },
      },
    );
    expect(result.conflicts).toEqual([]);
    expect(JSON.parse(result.text)).toEqual({
      ...base,
      nodes: [
        { id: 'a', command: 'local', extra: 1 },
        { id: 'b', command: 'remote' },
      ],
      policy: { maxParallel: 4 },
    });
  });
  it('refuses conflicting values and deletion versus editing', () => {
    expect(merge({ ...base, name: 'local' }, { ...base, name: 'remote' }).conflicts).toEqual([
      '/name',
    ]);
    expect(
      merge(
        { ...base, nodes: [] },
        { ...base, nodes: [{ id: 'a', command: 'changed' }, base.nodes[1]] },
      ).conflicts,
    ).toContain('/nodes/a');
  });
  it('keeps independent additions and deletions', () => {
    const result = merge(
      { ...base, nodes: [base.nodes[0]] },
      { ...base, nodes: [...base.nodes, { id: 'c', command: 'c' }] },
    );
    expect(result.conflicts).toEqual([]);
    expect(JSON.parse(result.text).nodes.map((node: { id: string }) => node.id)).toEqual([
      'a',
      'c',
    ]);
  });
});

describe('workflow run parameters', () => {
  it('preserves false, zero, typed JSON and string literals', () => {
    expect(
      parseWorkflowParameters(
        {
          zero: { type: 'number' },
          no: { type: 'boolean' },
          list: { type: 'array' },
          text: { type: 'string' },
          obj: { type: 'object' },
        },
        { zero: '0', no: 'false', list: '[1,2]', text: 'false', obj: '{"a":1}' },
      ),
    ).toEqual({
      values: { zero: 0, no: false, list: [1, 2], text: 'false', obj: { a: 1 } },
      errors: {},
    });
  });
  it('rejects missing, malformed and mismatched values before publishing', () => {
    expect(
      parseWorkflowParameters(
        {
          required: { required: true },
          num: { type: 'number' },
          obj: { type: 'object' },
          bool: { type: 'boolean' },
        },
        { num: 'NaN', obj: 'null', bool: 'yes' },
      ).errors,
    ).toEqual({ required: 'required', num: 'invalid', obj: 'invalid', bool: 'invalid' });
  });
  it('uses defaults and does not send absent optional values', () => {
    expect(
      parseWorkflowParameters(
        {
          flag: { type: 'boolean', default: false },
          count: { type: 'number', default: 0 },
          optional: { type: 'string' },
        },
        {},
      ),
    ).toEqual({ values: { flag: false, count: 0 }, errors: {} });
  });
});

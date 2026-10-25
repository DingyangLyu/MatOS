import { describe, expect, it } from 'vitest';
import {
  applyDependenciesToAssetJson,
  applyMetadataToAssetJson,
  applyRoleRuntimeToAssetJson,
  applySkillFieldsToFrontmatter,
  canvasJsonToWorkflowText,
  dataProvenanceFromAssetJson,
  dependenciesFromAssetJson,
  groupDependencies,
  joinFrontmatter,
  metadataFromAssetJson,
  roleRuntimeFromAssetJson,
  skillFieldsFromFrontmatter,
  splitFrontmatter,
  workflowTextToCanvasJson,
} from '../../src/components/asset-editors';

describe('asset metadata form round-trip', () => {
  const source = JSON.stringify(
    {
      type: 'skill',
      id: 'vasp-relax',
      name: 'VASP relax',
      description: 'Relax a structure',
      version: '0.1.0',
      tags: ['vasp'],
      custom: { keep: true },
    },
    null,
    2,
  );

  it('reads the form fields', () => {
    expect(metadataFromAssetJson(source)).toEqual({
      name: 'VASP relax',
      description: 'Relax a structure',
      version: '0.1.0',
      tags: ['vasp'],
    });
  });

  it('merges edits while preserving unknown fields', () => {
    const next = applyMetadataToAssetJson(source, {
      name: 'VASP relax v2',
      description: 'Relax with tighter EDIFF',
      version: '0.2.0',
      tags: ['vasp', 'dft'],
    });
    const parsed = JSON.parse(next);
    expect(parsed.name).toBe('VASP relax v2');
    expect(parsed.version).toBe('0.2.0');
    expect(parsed.tags).toEqual(['vasp', 'dft']);
    expect(parsed.custom).toEqual({ keep: true });
    expect(parsed.type).toBe('skill');
    expect(parsed.id).toBe('vasp-relax');
  });

  it('tolerates malformed JSON', () => {
    expect(metadataFromAssetJson('nope')).toEqual({
      name: '',
      description: '',
      version: '',
      tags: [],
    });
  });
});

describe('role dependency mounts', () => {
  const source = JSON.stringify({
    type: 'role',
    id: 'compute',
    dependencies: ['skill:vasp-relax', 'tool:qe-runner', 'knowledge:matbench@0.1.0'],
  });

  it('reads and groups dependencies by type', () => {
    const deps = dependenciesFromAssetJson(source);
    const groups = groupDependencies(deps);
    expect(groups.get('skill')).toEqual(['skill:vasp-relax']);
    expect(groups.get('tool')).toEqual(['tool:qe-runner']);
    expect(groups.get('knowledge')).toEqual(['knowledge:matbench@0.1.0']);
  });

  it('writes dependencies back preserving other fields', () => {
    const next = applyDependenciesToAssetJson(source, ['skill:vasp-relax', 'mcp:materials-project']);
    const parsed = JSON.parse(next);
    expect(parsed.dependencies).toEqual(['skill:vasp-relax', 'mcp:materials-project']);
    expect(parsed.id).toBe('compute');
  });
});

describe('role runtime overrides form', () => {
  const source = JSON.stringify({
    type: 'role',
    id: 'compute',
    runtime: {
      model: 'deepseek-v4-flash',
      effort: 'high',
      maxTurns: 5,
      initialPrompt: 'keep me',
    },
  });

  it('reads the runtime block into form fields', () => {
    expect(roleRuntimeFromAssetJson(source)).toEqual({
      model: 'deepseek-v4-flash',
      effort: 'high',
      permissionMode: '',
      maxTurns: '5',
    });
    expect(roleRuntimeFromAssetJson('{}')).toEqual({
      model: '',
      effort: '',
      permissionMode: '',
      maxTurns: '',
    });
  });

  it('merges edits, clears empty fields, and preserves non-form runtime keys', () => {
    const next = applyRoleRuntimeToAssetJson(source, {
      model: '',
      effort: 'max',
      permissionMode: 'plan',
      maxTurns: '',
    });
    const parsed = JSON.parse(next) as {
      id: string;
      runtime: Record<string, unknown>;
    };
    expect(parsed.runtime).toEqual({
      effort: 'max',
      permissionMode: 'plan',
      initialPrompt: 'keep me',
    });
    expect(parsed.id).toBe('compute');
  });

  it('drops the runtime block when every override is cleared', () => {
    const bare = JSON.stringify({ type: 'role', id: 'x', runtime: { effort: 'low' } });
    const next = applyRoleRuntimeToAssetJson(bare, {
      model: '',
      effort: '',
      permissionMode: '',
      maxTurns: '',
    });
    expect(JSON.parse(next)).toEqual({ type: 'role', id: 'x' });
  });
});

describe('skill frontmatter form', () => {
  const doc = [
    '---',
    'name: vasp-relax',
    '# operator note that must survive',
    'description: Relax a structure',
    'allowed-tools:',
    '  - Bash',
    'tags: [vasp]',
    '---',
    '',
    '# Steps',
    'Run the relax.',
    '',
  ].join('\n');

  it('splits and re-joins the document', () => {
    const parts = splitFrontmatter(doc);
    expect(parts.hasFrontmatter).toBe(true);
    expect(parts.body).toContain('# Steps');
    const rejoined = joinFrontmatter(parts);
    expect(rejoined).toContain('description: Relax a structure');
    expect(rejoined).toContain('# Steps');
  });

  it('handles documents without frontmatter', () => {
    const parts = splitFrontmatter('# Just markdown\n');
    expect(parts.hasFrontmatter).toBe(false);
    expect(joinFrontmatter(parts)).toBe('# Just markdown\n');
  });

  it('edits fields while preserving comments and unrelated keys', () => {
    const parts = splitFrontmatter(doc);
    const fields = skillFieldsFromFrontmatter(parts.frontmatter);
    expect(fields.description).toBe('Relax a structure');
    expect(fields.allowedTools).toEqual(['Bash']);
    const next = applySkillFieldsToFrontmatter(parts.frontmatter, {
      description: 'Relax with tighter EDIFF',
      allowedTools: ['Bash', 'Read'],
      tags: ['vasp', 'dft'],
    });
    expect(next).toContain('description: Relax with tighter EDIFF');
    expect(next).toContain('# operator note that must survive');
    expect(next).toContain('name: vasp-relax');
    const reread = skillFieldsFromFrontmatter(next);
    expect(reread.allowedTools).toEqual(['Bash', 'Read']);
    expect(reread.tags).toEqual(['vasp', 'dft']);
  });

  it('drops list keys emptied in the form', () => {
    const next = applySkillFieldsToFrontmatter('description: x\nallowed-tools: [Bash]', {
      description: 'x',
      allowedTools: [],
      tags: [],
    });
    expect(next).not.toContain('allowed-tools');
  });

  // Regression: many matos-core skill index files have an unquoted description
  // that contains ": " (e.g. "(6 sub-skills: ...)"). yaml records parse errors
  // on such a Document and refuses to stringify it, so the old editor threw
  // "Document with errors cannot be stringified" during render and took the
  // whole Assets view down. The editor must degrade gracefully instead.
  const malformed = [
    'name: code-interfaces',
    'description: Code Interfaces and Conversion Utilities (6 sub-skills: a, b, c)',
    'allowed-tools: [Bash]',
  ].join('\n');

  it('recovers real values from a colon-in-description frontmatter', () => {
    const fields = skillFieldsFromFrontmatter(malformed);
    expect(fields.description).toContain('Code Interfaces');
  });

  it('does not throw when re-serializing a malformed frontmatter', () => {
    expect(() =>
      applySkillFieldsToFrontmatter(malformed, {
        description: 'Code Interfaces and Conversion Utilities (6 sub-skills: a, b, c)',
        allowedTools: ['Bash'],
        tags: [],
      }),
    ).not.toThrow();
    const next = applySkillFieldsToFrontmatter(malformed, {
      description: 'Code Interfaces and Conversion Utilities (6 sub-skills: a, b, c)',
      allowedTools: ['Bash'],
      tags: [],
    });
    // Output must be valid YAML that round-trips (description now quoted).
    const reread = skillFieldsFromFrontmatter(next);
    expect(reread.description).toBe(
      'Code Interfaces and Conversion Utilities (6 sub-skills: a, b, c)',
    );
    expect(reread.allowedTools).toEqual(['Bash']);
    expect(next).toContain('name: code-interfaces');
  });
});

describe('workflow yaml/json canvas bridge', () => {
  it('passes JSON entries through untouched', () => {
    const json = '{"name":"wf","nodes":[]}';
    expect(workflowTextToCanvasJson(json, 'workflow.json')).toBe(json);
    expect(canvasJsonToWorkflowText(json, 'workflow.json')).toBe(json);
  });

  it('round-trips YAML entries through the canvas JSON model', () => {
    const yamlText = ['name: relax-and-report', 'nodes:', '  - id: relax', '    type: agent', ''].join('\n');
    const canvasJson = workflowTextToCanvasJson(yamlText, 'workflow.yaml');
    const parsed = JSON.parse(canvasJson);
    expect(parsed.name).toBe('relax-and-report');
    expect(parsed.nodes[0].id).toBe('relax');
    parsed.nodes.push({ id: 'report', type: 'agent' });
    const nextYaml = canvasJsonToWorkflowText(JSON.stringify(parsed), 'workflow.yaml');
    const reparsed = JSON.parse(workflowTextToCanvasJson(nextYaml, 'workflow.yaml'));
    expect(reparsed.nodes.map((n: { id: string }) => n.id)).toEqual(['relax', 'report']);
  });

  it('round-trips YAML entries with case-insensitive extensions', () => {
    const yamlText = 'name: upper-case\nnodes: []\n';
    const canvasJson = workflowTextToCanvasJson(yamlText, 'UPPER.WORKFLOW.YAML');
    expect(JSON.parse(canvasJson)).toMatchObject({ name: 'upper-case', nodes: [] });
    const nextYaml = canvasJsonToWorkflowText(canvasJson, 'UPPER.WORKFLOW.YAML');
    expect(JSON.parse(workflowTextToCanvasJson(nextYaml, 'workflow.yaml'))).toMatchObject({
      name: 'upper-case',
      nodes: [],
    });
  });
});

describe('data unit source & provenance profile', () => {
  it('reads TOS archive unit metadata written by the material-bench generator', () => {
    const source = JSON.stringify({
      type: 'data',
      id: 'mb-zenodo-7026970',
      metadata: {
        sourceFormat: 'material-bench-unit',
        generatedBy: 'scripts/material-bench-units-to-assets.py',
        provider: 'zenodo',
        providerId: '7026970',
        unitKind: 'dataset-record',
        unitOrigin: 'provenance-rows',
        doi: '10.5281/zenodo.7026970',
        sourceUrl: 'https://zenodo.org/records/7026970',
        sourceUrls: ['https://zenodo.org/records/7026970', 'https://doi.org/10.5281/zenodo.7026970'],
        payloadStatus: 'archived-tos',
        payloadKind: 'data',
        sizeHuman: '7.189 GiB',
        recordCount: 12,
        collections: ['multidomain_batch11_20260506'],
        path: '/workspace/knowledge/material-bench-datasets/multidomain_batch11_20260506',
        payloadPaths: ['/workspace/knowledge/material-bench-datasets/multidomain_batch11_20260506'],
        tosArchive: 'tos-example-bucket/example-user/material-bench-datasets-20260430/downloads',
        catalogTool: 'mcp__matos_asset__material_bench_dataset_catalog',
        recommendedQuery: { recordKind: 'unit', query: '7026970' },
        curationIssues: [],
      },
    });
    const fields = dataProvenanceFromAssetJson(source);
    expect(fields.present).toBe(true);
    expect(fields.generated).toBe(true);
    expect(fields.provider).toBe('zenodo');
    expect(fields.doi).toBe('10.5281/zenodo.7026970');
    expect(fields.sourceUrls).toEqual([
      'https://zenodo.org/records/7026970',
      'https://doi.org/10.5281/zenodo.7026970',
    ]);
    expect(fields.payloadStatus).toBe('archived-tos');
    expect(fields.sizeHuman).toBe('7.189 GiB');
    expect(fields.recordCount).toBe(12);
    expect(fields.recommendedQuery).toBe('{"recordKind":"unit","query":"7026970"}');
  });

  it('stays hidden for data assets without any source identity', () => {
    const fields = dataProvenanceFromAssetJson(
      JSON.stringify({ type: 'data', id: 'plain', metadata: { containerRoot: '/opt/x' } }),
    );
    expect(fields.present).toBe(false);
    expect(fields.generated).toBe(false);
  });
});

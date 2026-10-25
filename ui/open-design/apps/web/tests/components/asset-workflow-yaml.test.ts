import { it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { workflowTextToCanvasJson, canvasJsonToWorkflowText } from '../../src/components/asset-editors';
import { parseWorkflowDocument, serializeWorkflowDocument } from '../../src/components/workflow-model';

it('real MatOS workflow.yaml round-trips through the canvas model', () => {
  const yamlText = readFileSync(path.join(__dirname, 'wf-sample.yaml'), 'utf8');
  const json = workflowTextToCanvasJson(yamlText, 'workflow.yaml');
  const parsed = parseWorkflowDocument(json, 'sample');
  expect(parsed.definition.nodes.length).toBeGreaterThan(0);
  const serialized = serializeWorkflowDocument(parsed.definition);
  const backToYaml = canvasJsonToWorkflowText(serialized, 'workflow.yaml');
  const reparsed = parseWorkflowDocument(workflowTextToCanvasJson(backToYaml, 'workflow.yaml'), 'sample');
  expect(reparsed.definition.nodes.map((n) => n.id)).toEqual(parsed.definition.nodes.map((n) => n.id));
  expect(reparsed.definition.name).toBe(parsed.definition.name);
});

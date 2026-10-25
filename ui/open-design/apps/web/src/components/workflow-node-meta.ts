// Per-node-type canvas identity shared by every surface that draws MatOS
// workflow nodes: the Workflow Studio canvas/inspector (WorkflowEditor) and
// the lightweight card mini-maps (Home asset gallery, catalog tiles). Kept
// out of WorkflowEditor.tsx so gallery chunks don't pull React Flow along.
//
// Agent nodes are the star of the MatOS canvas (they mount role assets), so
// they get the brand accent. Everything else groups by responsibility:
// deterministic code (blue), science compute (purple), checks (green),
// humans (amber), composition/control flow (slate).

import type { IconName } from './Icon';

export interface WorkflowNodeTypeMeta {
  accent: string;
  icon: IconName;
  titleKey: string;
}

export const WORKFLOW_NODE_TYPE_META: Record<string, WorkflowNodeTypeMeta> = {
  agent: { accent: 'var(--accent, #c96442)', icon: 'sparkles', titleKey: 'workflow.typeTitle.agent' },
  exec: { accent: '#5b8def', icon: 'terminal', titleKey: 'workflow.typeTitle.exec' },
  compute: { accent: '#8b5bef', icon: 'orbit', titleKey: 'workflow.typeTitle.compute' },
  instrument: { accent: '#3aa6b9', icon: 'gauge', titleKey: 'lab.nodeTypeInstrument' },
  backend: { accent: '#5b8def', icon: 'hammer', titleKey: 'workflow.typeTitle.backend' },
  validate: { accent: '#2f9e6e', icon: 'check', titleKey: 'workflow.typeTitle.validate' },
  guard: { accent: '#2f9e6e', icon: 'eye', titleKey: 'workflow.typeTitle.guard' },
  human: { accent: '#d9822b', icon: 'comment', titleKey: 'workflow.typeTitle.human' },
  approval_gate: { accent: '#d9822b', icon: 'thumbs-up', titleKey: 'workflow.typeTitle.approval_gate' },
  subworkflow: { accent: '#7a7a8c', icon: 'blocks', titleKey: 'workflow.typeTitle.subworkflow' },
  map: { accent: '#7a7a8c', icon: 'grid', titleKey: 'workflow.typeTitle.map' },
  loop: { accent: '#7a7a8c', icon: 'refresh', titleKey: 'workflow.typeTitle.loop' },
  dynamic: { accent: '#7a7a8c', icon: 'lightbulb', titleKey: 'workflow.typeTitle.dynamic' },
};

export function workflowNodeTypeMeta(type: string): WorkflowNodeTypeMeta {
  return (
    WORKFLOW_NODE_TYPE_META[type] ?? {
      accent: 'var(--border, #444)',
      icon: 'file',
      titleKey: 'workflow.typeTitle.exec',
    }
  );
}

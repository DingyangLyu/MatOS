import { createMatOSAssetDraftProject } from '../matos-asset-projects';
import { matOSAssetSelectionRef, type MatOSAssetSummary } from '../runtime/matos-assets';
import type { useT } from '../i18n';
import { workflowTextToCanvasJson } from './asset-editors';

export async function createWorkflowAssetDraft(asset: MatOSAssetSummary, t: ReturnType<typeof useT>) {
  if (!/\.(json|ya?ml)$/i.test(asset.entry ?? '')) throw new Error(t('workflow.gallery.document'));
  const ref = matOSAssetSelectionRef(asset);
  const response = await fetch(`/api/matos/assets/${encodeURIComponent(ref)}`, { cache: 'no-store' });
  if (!response.ok) throw new Error(`${t('workflow.gallery.unavailable')} (HTTP ${response.status})`);
  const body = await response.json() as { files?: Array<{ name: string; content: string }> };
  const entry = body.files?.find(file => file.name === asset.entry);
  if (!entry) throw new Error(t('workflow.gallery.unavailable'));
  // Copy the full entry, never the capped preview or a normalized canvas:
  // retain parameters, policies, tools, nested workflows and extension fields.
  const definition = JSON.parse(workflowTextToCanvasJson(entry.content, entry.name));
  if (!definition || typeof definition !== 'object' || Array.isArray(definition)
    || !definition.nodes || typeof definition.nodes !== 'object'
    || Object.keys(definition.nodes).length === 0) throw new Error(t('workflow.gallery.unavailable'));
  return createMatOSAssetDraftProject('workflow', t, {
    pendingPrompt: null, name: asset.name, sourceAssetRef: ref, workflowDefinition: definition,
  });
}

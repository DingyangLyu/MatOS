// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MatOSAssetSummary } from '../../src/runtime/matos-assets';
import type { WorkflowPreviewGraph } from '../../src/components/workflow-minimap-model';

const { fetchMatOSAssets, createDraft, navigate } = vi.hoisted(() => ({
  fetchMatOSAssets: vi.fn(), createDraft: vi.fn(), navigate: vi.fn(),
}));
vi.mock('../../src/i18n', () => ({ useT: () => (key: string) => key }));
vi.mock('../../src/router', () => ({ navigate }));
vi.mock('../../src/matos-asset-projects', () => ({ createMatOSAssetDraftProject: createDraft }));
vi.mock('../../src/runtime/matos-assets', async importOriginal => ({
  ...await importOriginal<object>(), fetchMatOSAssets, getCachedMatOSAssets: () => undefined,
}));
import { MatOSAssetsHomeSection } from '../../src/components/MatOSAssetsHomeSection';
import { compareWorkflowAssets, WorkflowAssetCard } from '../../src/components/WorkflowAssetCard';
import { createWorkflowAssetDraft } from '../../src/components/workflow-asset-draft';

const asset = (id: string, entry = 'workflow.yaml'): MatOSAssetSummary => ({
  ref: `workflow:${id}`, canonicalKey: `workflow:${id}@1.0.0`, id, name: id, type: 'workflow',
  entry, tags: [], dependencies: [], version: '1.0.0', description: 'A real workflow',
  source: 'core', packId: null, status: 'enabled', runtime: null,
  git: { sourceId: null, scope: 'core', webUrl: null },
});
const preview = (id: string, count: number): WorkflowPreviewGraph => ({
  ref: `workflow:${id}`, canonicalKey: `workflow:${id}@1.0.0`, nodeCount: count, edgeCount: count - 1,
  nodes: [{ id: 'one', label: 'one', type: 'exec' }], edges: [],
});
const t = ((key: string) => key) as Parameters<typeof createWorkflowAssetDraft>[1];
afterEach(() => { cleanup(); vi.resetAllMocks(); vi.unstubAllGlobals(); });

describe('workflow gallery', () => {
  it('re-sorts before taking six cards when previews arrive after the catalog', async () => {
    const assets = [asset('a-doc', 'WORKFLOW.md'), ...Array.from({ length: 7 }, (_, i) => asset(`flow-${i}`))];
    fetchMatOSAssets.mockResolvedValue(assets);
    let complete!: (value: unknown) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise(resolve => { complete = resolve; })));
    const view = render(<MatOSAssetsHomeSection />);
    await screen.findByText('a-doc');
    await act(async () => complete({ ok: true, json: async () => ({ previews: Array.from({ length: 7 }, (_, i) => preview(`flow-${i}`, i + 1)) }) }));
    const refs = [...view.container.querySelectorAll('[data-asset-ref]')].map(el => el.getAttribute('data-asset-ref'));
    expect(refs).toEqual([6, 5, 4, 3, 2, 1].map(i => `workflow:flow-${i}`));
    fireEvent.click(screen.getByTestId('matos-assets-home-open-workflow:flow-6'));
    expect(navigate).toHaveBeenCalledWith({ kind: 'home', view: 'assets', assetRef: 'workflow:flow-6@1.0.0' });
  });

  it('retries a failed preview request instead of caching failure forever', async () => {
    fetchMatOSAssets.mockResolvedValue([asset('flow')]);
    const request = vi.fn().mockResolvedValueOnce({ ok: false })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ previews: [preview('flow', 6)] }) });
    vi.stubGlobal('fetch', request);
    render(<MatOSAssetsHomeSection />);
    fireEvent.click(await screen.findByRole('button', { name: 'library.refresh' }));
    await waitFor(() => expect(document.querySelector('[data-node-count="6"]')).toBeTruthy());
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('uses total counts, exact versions and deterministic ties', () => {
    const a = asset('a'); const b = asset('b');
    const map = new Map([['workflow:a@1.0.0', preview('a', 28)], ['workflow:b@1.0.0', preview('b', 25)]]);
    expect(compareWorkflowAssets(a, b, map)).toBeLessThan(0);
    expect(compareWorkflowAssets(a, b, new Map())).toBeLessThan(0);
    const other = { ...a, canonicalKey: 'workflow:a@2.0.0', ref: 'workflow:a@2.0.0', version: '2.0.0' };
    expect(compareWorkflowAssets(other, b, map)).toBeGreaterThan(0);
  });

  it('does not label prose or broken graphs as runnable', () => {
    const view = render(<WorkflowAssetCard asset={asset('docs', 'WORKFLOW.md')} previews={new Map()} />);
    expect(screen.getAllByText('workflow.gallery.document').length).toBeGreaterThan(0);
    expect(screen.queryByTestId('workflow-asset-edit-copy')).toBeNull();
    expect(view.container.querySelector('.plugins-home__gallery-dot')).toBeNull();
    view.rerender(<WorkflowAssetCard asset={asset('broken')} previews={null} />);
    expect((screen.getByTestId('workflow-asset-edit-copy') as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('workflow asset draft', () => {
  it('copies the full exact YAML entry to a named project without editing or running the source', async () => {
    const definition = { schemaVersion: 1, name: 'original', policy: { approvalMode: 'prompt' },
      parameters: { value: { type: 'string', default: 'x' } }, nodes: Array.from({ length: 30 }, (_, i) => ({ id: `n${i}`, type: 'exec', command: ['printf', 'ok'] })), outputs: { text: '${nodes.n29.stdout}' } };
    const request = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ files: [{ name: 'workflow.yaml', content: JSON.stringify(definition) }] }) });
    vi.stubGlobal('fetch', request);
    createDraft.mockResolvedValue({ projectId: 'copy', conversationId: null, seedName: 'workflow.json' });
    await createWorkflowAssetDraft(asset('flow'), t);
    expect(request).toHaveBeenCalledWith('/api/matos/assets/workflow%3Aflow%401.0.0', { cache: 'no-store' });
    expect(createDraft).toHaveBeenCalledWith('workflow', t, { name: 'flow', sourceAssetRef: 'workflow:flow@1.0.0', pendingPrompt: null, workflowDefinition: definition });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it.each([
    { ok: false, status: 403 },
    { ok: true, json: async () => ({ files: [] }) },
    { ok: true, json: async () => ({ files: [{ name: 'workflow.yaml', content: 'not a definition' }] }) },
  ])('fails closed on denied, missing or malformed definitions', async response => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
    await expect(createWorkflowAssetDraft(asset('flow'), t)).rejects.toThrow();
    expect(createDraft).not.toHaveBeenCalled();
  });

  it('surfaces copy failures and does not navigate to an unsaved draft', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ files: [{ name: 'workflow.yaml', content: 'nodes: [{id: one, type: exec}]' }] }) }));
    createDraft.mockRejectedValue(new Error('write denied'));
    render(<WorkflowAssetCard asset={asset('flow')} previews={new Map([['workflow:flow', preview('flow', 1)]])} />);
    fireEvent.click(screen.getByTestId('workflow-asset-edit-copy'));
    await screen.findByRole('alert');
    expect(screen.getByRole('alert').textContent).toBe('write denied');
    expect(navigate).not.toHaveBeenCalled();
  });
});

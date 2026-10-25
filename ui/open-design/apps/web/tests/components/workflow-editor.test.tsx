// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../src/i18n';
import { useState } from 'react';
import { WorkflowEditorCore } from '../../src/components/WorkflowEditor';
import { publishWorkflowDefinition } from '../../src/components/matos-workflow-client';

vi.mock('@xyflow/react', () => ({
  ReactFlow: ({ nodes, onNodesChange }: any) => (
    <div>
      {nodes.map((node: any) => (
        <button
          key={node.id}
          onClick={() => onNodesChange([{ type: 'select', id: node.id, selected: true }])}
        >
          {node.id}
        </button>
      ))}
    </div>
  ),
  Background: () => null,
  Controls: () => null,
  MiniMap: () => null,
  Handle: () => null,
  Position: { Left: 'left', Right: 'right' },
}));
vi.mock('../../src/components/matos-workflow-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/components/matos-workflow-client')>()),
  publishWorkflowDefinition: vi.fn(async () => ({
    validation: { ok: false, errors: [], diagnostics: [] },
    published: null,
  })),
}));

const definition = JSON.stringify({
  schemaVersion: 1,
  name: 'Example',
  version: '1.0.0',
  nodes: [{ id: 'step', type: 'exec', command: 'echo before', dependsOn: [] }],
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('workflow editor persistence', () => {
  it('keeps the same unsaved editor when the project focuses and restores the canvas', async () => {
    const loadText = vi.fn(async () => definition);
    const saveText = vi.fn(async () => undefined);
    function ProjectFocusHarness() {
      const [focusMode, setFocusMode] = useState(false);
      return <WorkflowEditorCore docKey="focus" fileLabel="test.workflow.json"
        fallbackName="Example" sourceKey="1" loadText={loadText} saveText={saveText}
        focusMode={focusMode} onFocusModeChange={setFocusMode} />;
    }
    render(<I18nProvider><ProjectFocusHarness /></I18nProvider>);
    fireEvent.click(await screen.findByText('step'));
    const command = screen.getByRole('textbox', { name: 'Command' });
    fireEvent.input(command, { target: { value: 'echo unsaved' } });
    fireEvent.blur(command);
    fireEvent.click(screen.getByTestId('workflow-focus-toggle'));
    expect(screen.getByTestId('workflow-focus-toggle').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByDisplayValue('echo unsaved')).toBeTruthy();
    fireEvent.click(screen.getByTestId('workflow-focus-toggle'));
    expect(screen.getByTestId('workflow-focus-toggle').getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByDisplayValue('echo unsaved')).toBeTruthy();
    expect(loadText).toHaveBeenCalledTimes(1);
    expect(saveText).not.toHaveBeenCalled();
  });

  it('never publishes after a failed save', async () => {
    const saveText = vi.fn(async () => {
      throw new Error('Storage unavailable');
    });
    render(
      <I18nProvider>
        <WorkflowEditorCore
          docKey="test"
          fileLabel="test.workflow.json"
          fallbackName="Example"
          sourceKey="1"
          loadText={async () => definition}
          saveText={saveText}
        />
      </I18nProvider>,
    );
    await screen.findByText('step');
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));
    fireEvent.click(screen.getByRole('button', { name: 'Publish and start' }));
    await waitFor(() => expect(saveText).toHaveBeenCalled());
    await screen.findByText('Storage unavailable');
    expect(publishWorkflowDefinition).not.toHaveBeenCalled();
  });

  it('keeps external edits for review and refreshes fields even when node IDs are unchanged', async () => {
    let source = definition;
    const loadText = async () => source;
    const saveText = vi.fn(async () => undefined);
    const props = {
      docKey: 'external',
      fileLabel: 'test.workflow.json',
      fallbackName: 'Example',
      loadText,
      saveText,
    };
    const { rerender } = render(
      <I18nProvider>
        <WorkflowEditorCore {...props} sourceKey="1" />
      </I18nProvider>,
    );
    fireEvent.click(await screen.findByText('step'));
    expect(screen.getByDisplayValue('echo before')).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: 'JSON' }));
    fireEvent.input(screen.getByRole('textbox'), { target: { value: '{invalid local draft' } });
    fireEvent.blur(screen.getByRole('textbox'));
    fireEvent.click(screen.getByRole('tab', { name: 'Config' }));
    source = definition.replace('echo before', 'echo remote');
    rerender(
      <I18nProvider>
        <WorkflowEditorCore {...props} sourceKey="2" />
      </I18nProvider>,
    );
    await screen.findByTestId('workflow-conflict');
    expect((screen.getByRole('button', { name: 'Merge independent changes' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByDisplayValue('echo before')).toBeTruthy();
    expect(saveText).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Use latest file' }));
    expect(screen.getByDisplayValue('echo remote')).toBeTruthy();
  });

  it('never publishes a broken document or a failed read', async () => {
    const saveText = vi.fn(async () => undefined);
    render(
      <I18nProvider>
        <WorkflowEditorCore
          docKey="broken"
          fileLabel="broken.workflow.json"
          fallbackName="Broken"
          sourceKey="1"
          loadText={async () => '{bad json'}
          saveText={saveText}
        />
      </I18nProvider>,
    );
    await screen.findByTestId('workflow-editor');
    expect((screen.getByRole('button', { name: 'Run' }) as HTMLButtonElement).disabled).toBe(true);
    expect(saveText).not.toHaveBeenCalled();
  });

  it('preserves invalid node JSON across tab switches and blocks running the previous value', async () => {
    const saveText = vi.fn(async (_text: string) => undefined);
    render(
      <I18nProvider>
        <WorkflowEditorCore
          docKey="json"
          fileLabel="test.workflow.json"
          fallbackName="Example"
          sourceKey="1"
          loadText={async () => definition}
          saveText={saveText}
        />
      </I18nProvider>,
    );
    fireEvent.click(await screen.findByText('step'));
    fireEvent.click(screen.getByRole('tab', { name: 'JSON' }));
    const json = screen.getByRole('textbox');
    fireEvent.input(json, { target: { value: '{invalid' } });
    fireEvent.blur(json);
    expect((screen.getByRole('button', { name: 'Run' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('tab', { name: 'Config' }));
    fireEvent.click(screen.getByRole('tab', { name: 'JSON' }));
    expect(screen.getByDisplayValue('{invalid')).toBeTruthy();
    fireEvent.input(screen.getByRole('textbox'), {
      target: { value: JSON.stringify({ id: 'step', type: 'exec', command: 'echo corrected' }) },
    });
    fireEvent.blur(screen.getByRole('textbox'));
    expect((screen.getByRole('button', { name: 'Run' }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(saveText).toHaveBeenCalled());
    expect(JSON.parse(saveText.mock.calls[0]![0]!).nodes[0].command).toBe('echo corrected');
    expect(publishWorkflowDefinition).not.toHaveBeenCalled();
  });

  it.each([
    { id: 'step', command: 'echo unsafe default' },
    { id: 'step', type: 'exec', command: 'echo unchanged', dependsOn: ['missing'] },
    { id: 'step', type: 'exec', command: 'echo unchanged', dependsOn: ['step'] },
  ])('does not silently repair invalid JSON node types or dependencies: %j', async (node) => {
    render(<I18nProvider><WorkflowEditorCore docKey="invalid-node" fileLabel="test.workflow.json" fallbackName="Example" sourceKey="1" loadText={async () => definition} saveText={async () => undefined} /></I18nProvider>);
    fireEvent.click(await screen.findByText('step'));
    fireEvent.click(screen.getByRole('tab', { name: 'JSON' }));
    fireEvent.input(screen.getByRole('textbox'), { target: { value: JSON.stringify(node) } });
    fireEvent.blur(screen.getByRole('textbox'));
    expect((screen.getByRole('button', { name: 'Run' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByDisplayValue(JSON.stringify(node))).toBeTruthy();
  });

  it('warns before leaving an input that has not blurred or committed yet', async () => {
    render(
      <I18nProvider>
        <WorkflowEditorCore
          docKey="typing"
          fileLabel="test.workflow.json"
          fallbackName="Example"
          sourceKey="1"
          loadText={async () => definition}
          saveText={async () => undefined}
        />
      </I18nProvider>,
    );
    fireEvent.click(await screen.findByText('step'));
    fireEvent.input(screen.getByRole('textbox', { name: 'Command' }), {
      target: { value: 'echo typed' },
    });
    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it('retains invalid parameter defaults instead of silently using a previous value', async () => {
    const text = JSON.stringify({
      ...JSON.parse(definition),
      parameters: { amount: { type: 'number', default: 1 } },
    });
    render(
      <I18nProvider>
        <WorkflowEditorCore
          docKey="parameters"
          fileLabel="test.workflow.json"
          fallbackName="Example"
          sourceKey="1"
          loadText={async () => text}
          saveText={async () => undefined}
        />
      </I18nProvider>,
    );
    await screen.findByText('step');
    fireEvent.click(screen.getByRole('button', { name: 'Workflow settings' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Default value' }), {
      target: { value: 'invalid' },
    });
    expect((screen.getByRole('button', { name: 'Run' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    fireEvent.click(screen.getByRole('button', { name: 'Workflow settings' }));
    expect(screen.getByDisplayValue('invalid')).toBeTruthy();
    fireEvent.change(screen.getByRole('textbox', { name: /Default value/ }), {
      target: { value: '2' },
    });
    expect((screen.getByRole('button', { name: 'Run' }) as HTMLButtonElement).disabled).toBe(false);
  });
});

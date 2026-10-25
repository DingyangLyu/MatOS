import { describe, expect, it } from 'vitest';

import {
  countFileOps,
  deriveFileOps,
  filterUserVisibleFileEvents,
} from '../../src/runtime/file-ops';
import type { AgentEvent } from '../../src/types';

type ToolUse = Extract<AgentEvent, { kind: 'tool_use' }>;
type ToolResult = Extract<AgentEvent, { kind: 'tool_result' }>;

function use(name: string, input: unknown, id: string): ToolUse {
  return { kind: 'tool_use', id, name, input };
}

function ok(id: string, content = ''): ToolResult {
  return { kind: 'tool_result', toolUseId: id, content, isError: false };
}

function fail(id: string, content = 'boom'): ToolResult {
  return { kind: 'tool_result', toolUseId: id, content, isError: true };
}

describe('deriveFileOps', () => {
  it.each([
    ['read', { file_path: '/repo/result.txt' }, 'read'],
    ['read_image', { file_path: '/repo/result.png' }, 'read'],
    ['write', { file_path: '/repo/result.txt', content: 'result' }, 'write'],
    ['edit', { file_path: '/repo/result.txt', old_string: 'x', new_string: 'y' }, 'edit'],
    ['str_replace_editor', { command: 'view', path: '/repo/result.txt' }, 'read'],
    ['str_replace_editor', { command: 'create', path: '/repo/result.txt', file_text: 'x' }, 'write'],
    ['str_replace_editor', { command: 'str_replace', path: '/repo/result.txt', old_str: 'x', new_str: 'y' }, 'edit'],
    ['bash', { command: 'rm result.txt' }, 'delete'],
  ] as const)('recognizes native DSH %s operations', (name, input, kind) => {
    const rows = deriveFileOps([use(name, input, 'dsh-1'), ok('dsh-1')]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ ops: [kind], status: 'done', total: 1 });
  });

  it('returns an empty list for an empty event stream', () => {
    expect(deriveFileOps(undefined)).toEqual([]);
    expect(deriveFileOps([])).toEqual([]);
  });

  it('applies the existing internal-file filter to DSH names and editor commands', () => {
    const events = [
      use('read', { file_path: '.matos/sessions/private.jsonl' }, 'read-private'), ok('read-private'),
      use('str_replace_editor', { command: 'view', path: '.matos/evolution/monitor/private.jsonl' }, 'editor-private'), ok('editor-private'),
      use('read', { file_path: 'results.txt' }, 'read-visible'), ok('read-visible'),
    ];
    expect(filterUserVisibleFileEvents(events)).toEqual(events.slice(4));
    expect(deriveFileOps(events).map(row => row.path)).toEqual(['results.txt']);
  });

  it('skips tool_use events that are not file CRUD families', () => {
    const events: AgentEvent[] = [
      use('Bash', { command: 'ls' }, 't1'),
      use('TodoWrite', { todos: [] }, 't2'),
      use('WebSearch', { query: 'foo' }, 't3'),
    ];
    expect(deriveFileOps(events)).toEqual([]);
  });

  it('aggregates Read/Write/Edit/Delete by full path with basename + ops list', () => {
    const events: AgentEvent[] = [
      use('Read', { file_path: '/repo/a.ts' }, 't1'),
      ok('t1'),
      use('Write', { file_path: '/repo/b.ts', content: 'hi' }, 't2'),
      ok('t2'),
      use('Edit', { file_path: '/repo/a.ts', old_string: 'x', new_string: 'y' }, 't3'),
      ok('t3'),
      use('delete_file', { file_path: '/repo/c.ts' }, 't4'),
      ok('t4'),
    ];
    const rows = deriveFileOps(events);
    expect(rows).toHaveLength(3);
    const a = rows.find((row) => row.fullPath === '/repo/a.ts');
    expect(a).toMatchObject({
      path: 'a.ts',
      fullPath: '/repo/a.ts',
      ops: ['read', 'edit'],
      total: 2,
      status: 'done',
    });
    const b = rows.find((row) => row.fullPath === '/repo/b.ts');
    expect(b).toMatchObject({
      path: 'b.ts',
      ops: ['write'],
      total: 1,
      status: 'done',
    });
    const c = rows.find((row) => row.fullPath === '/repo/c.ts');
    expect(c).toMatchObject({
      path: 'c.ts',
      ops: ['delete'],
      total: 1,
      status: 'done',
    });
  });

  it('deduplicates repeated tool_use events that share an id', () => {
    const events: AgentEvent[] = [
      use('Write', { file_path: '/repo/index.html', content: '<main />' }, 't1'),
      use('Write', { file_path: '/repo/index.html', content: '<main />' }, 't1'),
      ok('t1'),
    ];
    const rows = deriveFileOps(events);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      path: 'index.html',
      ops: ['write'],
      total: 1,
    });
    expect(countFileOps(rows).write).toBe(1);
  });

  it('treats a missing tool_result as running and an isError result as error', () => {
    const events: AgentEvent[] = [
      use('Read', { file_path: '/repo/a.ts' }, 't1'),
      use('Edit', { file_path: '/repo/b.ts' }, 't2'),
      fail('t2'),
    ];
    const rows = deriveFileOps(events);
    expect(rows.find((row) => row.path === 'a.ts')?.status).toBe('running');
    expect(rows.find((row) => row.path === 'b.ts')?.status).toBe('error');
  });

  it('worst status wins when one file gets multiple results', () => {
    const events: AgentEvent[] = [
      use('Read', { file_path: '/repo/a.ts' }, 't1'),
      ok('t1'),
      use('Edit', { file_path: '/repo/a.ts' }, 't2'),
      fail('t2'),
    ];
    const [row] = deriveFileOps(events);
    expect(row?.status).toBe('error');
  });

  it('accepts the legacy `path` argument and the snake_case tool aliases', () => {
    const events: AgentEvent[] = [
      use('read_file', { path: '/repo/a.ts' }, 't1'),
      ok('t1'),
      use('create_file', { path: '/repo/b.ts' }, 't2'),
      ok('t2'),
      use('str_replace_edit', { path: '/repo/a.ts' }, 't3'),
      ok('t3'),
      use('remove_file', { target_path: '/repo/c.ts' }, 't4'),
      ok('t4'),
    ];
    const rows = deriveFileOps(events);
    expect(rows.map((row) => row.path).sort()).toEqual(['a.ts', 'b.ts', 'c.ts']);
    expect(rows.find((row) => row.path === 'a.ts')?.ops).toEqual(['read', 'edit']);
    expect(rows.find((row) => row.path === 'c.ts')?.ops).toEqual(['delete']);
  });

  it('infers simple Bash rm/unlink targets as delete operations', () => {
    const events: AgentEvent[] = [
      use(
        'Bash',
        { command: 'rm -f ./stale.txt "old file.md" *.log && unlink loose.tmp; echo done' },
        't1',
      ),
      ok('t1'),
    ];

    const rows = deriveFileOps(events);
    expect(rows.map((row) => row.fullPath).sort()).toEqual([
      './stale.txt',
      'loose.tmp',
      'old file.md',
    ]);
    expect(rows.map((row) => row.ops)).toEqual([['delete'], ['delete'], ['delete']]);
  });

  it('stops Bash rm target inference at pipes and redirections', () => {
    const events: AgentEvent[] = [
      use('Bash', { command: 'rm old.txt | cat deletion.log' }, 't1'),
      ok('t1'),
      use('Bash', { command: 'rm stale.txt > deletion.log 2> errors.log' }, 't2'),
      ok('t2'),
      use('Bash', { command: 'rm ./queued.tmp& echo done' }, 't3'),
      ok('t3'),
    ];

    const rows = deriveFileOps(events);
    expect(rows.map((row) => row.fullPath).sort()).toEqual([
      './queued.tmp',
      'old.txt',
      'stale.txt',
    ]);
  });

  it('drops events whose path is missing or "(unnamed)"', () => {
    const events: AgentEvent[] = [
      use('Write', { file_path: '' }, 't1'),
      use('Read', { file_path: '(unnamed)' }, 't2'),
      use('Edit', {}, 't3'),
    ];
    expect(deriveFileOps(events)).toEqual([]);
  });

  it('hides MatOS session and self-evolution writes from files-this-turn', () => {
    const events: AgentEvent[] = [
      use('Write', { file_path: '.matos/sessions/session-id.jsonl' }, 't1'),
      ok('t1'),
      use(
        'Write',
        { file_path: '.matos/evolution/monitor/sessions/session-id/records.jsonl' },
        't2',
      ),
      ok('t2'),
      use('Write', { file_path: '.matos/evolution/monitor/claims/session-id' }, 't3'),
      ok('t3'),
      use('Write', { file_path: '.matos/assets/packs/project/asset.json' }, 't4'),
      ok('t4'),
      use('Write', { file_path: 'results/energy.out' }, 't5'),
      ok('t5'),
    ];

    expect(deriveFileOps(events).map((entry) => entry.fullPath)).toEqual([
      '.matos/assets/packs/project/asset.json',
      'results/energy.out',
    ]);
    const visibleEvents = filterUserVisibleFileEvents(events);
    expect(visibleEvents.some((event) =>
      event.kind === 'tool_use' && event.id === 't1')).toBe(false);
    expect(visibleEvents.some((event) =>
      event.kind === 'tool_result' && event.toolUseId === 't1')).toBe(false);
    expect(visibleEvents.some((event) =>
      event.kind === 'tool_use' && event.id === 't4')).toBe(true);
  });

  it('treats Windows-style paths and trailing slashes the same as POSIX', () => {
    const events: AgentEvent[] = [
      use('Read', { file_path: 'C:\\repo\\sub\\file.ts' }, 't1'),
      ok('t1'),
    ];
    const [row] = deriveFileOps(events);
    expect(row?.path).toBe('file.ts');
  });
});

describe('countFileOps', () => {
  it('totals tool_use counts by op family across all entries', () => {
    const events: AgentEvent[] = [
      use('Read', { file_path: '/a.ts' }, 't1'),
      ok('t1'),
      use('Read', { file_path: '/a.ts' }, 't2'),
      ok('t2'),
      use('Write', { file_path: '/b.ts' }, 't3'),
      ok('t3'),
      use('Edit', { file_path: '/a.ts' }, 't4'),
      ok('t4'),
      use('Delete', { path: '/gone.ts' }, 't5'),
      ok('t5'),
    ];
    const rows = deriveFileOps(events);
    const counts = countFileOps(rows);
    expect(counts.read).toBe(2);
    expect(counts.write).toBe(1);
    expect(counts.edit).toBe(1);
    expect(counts.delete).toBe(1);
  });

  it('returns zeros when there are no entries', () => {
    expect(countFileOps([])).toEqual({ read: 0, write: 0, edit: 0, delete: 0 });
  });
});

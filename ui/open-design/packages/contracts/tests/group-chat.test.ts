import { describe, expect, it } from 'vitest';

import {
  buildGroupFanOutStubPrompt,
  buildGroupHistoryCompactionNotice,
  buildGroupRelayStubPrompt,
  buildReplyExcerpt,
  formatReplyQuote,
  formatTurnFileReferences,
  parseGroupRelayDispatch,
  parseGroupRelayTargets,
  REPLY_EXCERPT_MAX_CHARS,
} from '../src/group-chat';

// The parsing grammar itself is exercised end-to-end by the web suite
// (apps/web/tests/providers/daemon-group-transcript.test.ts) through the
// provider re-exports. Here we pin the daemon-only surface: the stub prompt
// the daemon persists as the dispatch turn (group log row + DM work-ledger
// entry for the target member).

describe('buildGroupRelayStubPrompt', () => {
  it('carries the handoff task text so the ledger row is self-contained', () => {
    const [target] = parseGroupRelayTargets(
      '弛豫算完了。\n@学术研究: 基于以上结果撰写方法学部分',
      [
        { ref: 'role:compute', name: '算力老王' },
        { ref: 'role:academic', name: '学术研究' },
      ],
      'role:compute',
    );
    expect(target).toEqual({
      ref: 'role:academic',
      name: '学术研究',
      task: '基于以上结果撰写方法学部分',
    });
    expect(buildGroupRelayStubPrompt(target!)).toBe('@学术研究 基于以上结果撰写方法学部分');
  });

  it('falls back to a bilingual continue marker when the handoff has no task text', () => {
    const prompt = buildGroupRelayStubPrompt({ ref: 'role:academic', name: '学术研究', task: '' });
    expect(prompt.startsWith('@学术研究 ')).toBe(true);
    // Daemon-side dispatch has no client locale, so both languages ship.
    expect(prompt).toContain('请继续处理');
    expect(prompt).toContain('continue the handoff task');
  });
});

describe('buildGroupFanOutStubPrompt', () => {
  it('points the member at the user message that mentioned them', () => {
    const prompt = buildGroupFanOutStubPrompt({ ref: 'role:academic', name: '学术研究' });
    expect(prompt.startsWith('@学术研究 ')).toBe(true);
    expect(prompt).toContain('请处理上面用户消息中');
    expect(prompt).toContain('handle the part addressed to you');
  });
});

describe('parseGroupRelayDispatch (unmatched handoffs)', () => {
  const TEAM = [
    { ref: 'role:compute', name: '算力老王' },
    { ref: 'role:academic', name: '学术研究' },
  ];

  it('surfaces colon-shaped handoff lines whose label matches no member', () => {
    const text = [
      '计算完成。',
      '@学术研究: 整理文献对照表',
      '@数据分析师: 做误差分析',
    ].join('\n');
    const parsed = parseGroupRelayDispatch(text, TEAM, 'role:compute');
    expect(parsed.targets).toEqual([
      { ref: 'role:academic', name: '学术研究', task: '整理文献对照表' },
    ]);
    // "数据分析师" is not in the roster — the daemon posts a dispatch notice
    // instead of silently dropping the intended handoff.
    expect(parsed.unmatchedHandoffLabels).toEqual(['数据分析师']);
  });

  it('never reports prose mentions or self-handoffs as unmatched', () => {
    // No colon = prose, not a handoff shape.
    expect(
      parseGroupRelayDispatch('结论同 @前面讨论 一致。', TEAM, 'role:compute')
        .unmatchedHandoffLabels,
    ).toEqual([]);
    // A trailing self-handoff matches the roster (just not a candidate), so
    // it stays silently ignored, exactly like before.
    expect(
      parseGroupRelayDispatch('做完了。\n@算力老王: 继续跑下一批', TEAM, 'role:compute')
        .unmatchedHandoffLabels,
    ).toEqual([]);
  });
});

describe('buildGroupHistoryCompactionNotice', () => {
  it('tells the agent where the full history persists and how to filter it', () => {
    const notice = buildGroupHistoryCompactionNotice({
      omittedCount: 12,
      conversationId: 'conv-battery',
    });
    expect(notice).toContain('## Earlier group history compacted');
    expect(notice).toContain('12 older message(s)');
    expect(notice).toContain('.matos/workbench/project-events.jsonl');
    expect(notice).toContain('conversationId "conv-battery"');
  });

  it('returns an empty string when nothing was omitted', () => {
    expect(buildGroupHistoryCompactionNotice({ omittedCount: 0 })).toBe('');
  });
});

describe('quote-reply excerpt and rendering', () => {
  it('collapses whitespace and bounds the excerpt with an ellipsis', () => {
    expect(buildReplyExcerpt('弛豫已经完成，\n\n结果在  relax-results/。')).toBe(
      '弛豫已经完成， 结果在 relax-results/。',
    );
    const long = 'x'.repeat(500);
    const excerpt = buildReplyExcerpt(long);
    expect(excerpt.length).toBeLessThanOrEqual(REPLY_EXCERPT_MAX_CHARS);
    expect(excerpt.endsWith('…')).toBe(true);
  });

  it('renders a one-line quote attributed to the member or the user', () => {
    expect(
      formatReplyQuote({ authorName: '算力老王', excerpt: '弛豫已经完成，结果在 relax-results/。' }),
    ).toBe('[in reply to 算力老王: "弛豫已经完成，结果在 relax-results/。"]');
    // Null author = the human user's turn (fan-out stubs quote the dispatch).
    expect(formatReplyQuote({ authorName: null, excerpt: '@A 跑弛豫 @B 查文献' })).toBe(
      '[in reply to user: "@A 跑弛豫 @B 查文献"]',
    );
    expect(formatReplyQuote({ excerpt: '' })).toBe('[in reply to user]');
  });
});

describe('formatTurnFileReferences', () => {
  it('lists attached and produced files as compact reference lines', () => {
    const annotated = formatTurnFileReferences({
      // Persisted ChatAttachment objects and bare path strings both occur.
      attachments: [
        { path: 'inputs/BaTiO3.cif', name: 'BaTiO3.cif', kind: 'file' },
        'notes/protocol.md',
      ],
      producedFiles: [
        { name: 'relax-results/OUTCAR', size: 12_345 },
        { name: 'relax-results/CONTCAR' },
      ],
    });
    expect(annotated).toBe(
      '[attached files: `inputs/BaTiO3.cif`, `notes/protocol.md`]\n' +
        '[produced files: `relax-results/OUTCAR`, `relax-results/CONTCAR`]',
    );
  });

  it('bounds long produced-file lists instead of flooding the transcript', () => {
    const producedFiles = Array.from({ length: 12 }, (_, index) => ({
      name: `sweep/run-${index}.json`,
    }));
    const annotated = formatTurnFileReferences({ producedFiles });
    expect(annotated).toContain('`sweep/run-0.json`');
    expect(annotated).toContain('`sweep/run-7.json`');
    expect(annotated).not.toContain('run-8.json');
    expect(annotated).toContain('+4 more');
  });

  it('returns an empty string for turns without files', () => {
    expect(formatTurnFileReferences({})).toBe('');
    expect(formatTurnFileReferences({ attachments: [], producedFiles: [{ name: '' }] })).toBe('');
  });
});

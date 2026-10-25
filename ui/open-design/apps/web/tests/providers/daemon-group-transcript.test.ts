import { describe, expect, it } from 'vitest';

import {
  buildDaemonTranscript,
  buildGroupContextHeader,
  GROUP_DISPATCH_MAX_TARGETS,
  GROUP_RELAY_MAX_HOPS,
  parseGroupRelayTarget,
  parseGroupRelayTargets,
  parseUserGroupMentions,
  type ChatGroupContext,
} from '../../src/providers/daemon';
import type { ChatMessage } from '../../src/types';

const GROUP: ChatGroupContext = {
  members: [
    { ref: 'role:compute', name: 'Compute' },
    { ref: 'role:academic', name: 'Academic Research' },
  ],
  respondingRef: 'role:academic',
  respondingName: 'Academic Research',
};

function msg(partial: Partial<ChatMessage> & Pick<ChatMessage, 'id' | 'role' | 'content'>): ChatMessage {
  return { ...partial } as ChatMessage;
}

describe('group chat transcript', () => {
  it('keeps plain conversations byte-identical (no group context)', () => {
    const history = [
      msg({ id: 'u1', role: 'user', content: 'hello' }),
      msg({ id: 'a1', role: 'assistant', content: 'hi', agentId: 'matos' }),
    ];
    const transcript = buildDaemonTranscript(history, 'matos');
    expect(transcript).toBe('## user\nhello\n\n## assistant\nhi');
  });

  it('prefixes the roster header and attributes turns to members', () => {
    const history = [
      msg({ id: 'u1', role: 'user', content: 'plan the study', roleRef: 'role:compute' }),
      msg({
        id: 'a1',
        role: 'assistant',
        content: 'I ran the relaxations.',
        agentId: 'matos',
        roleRef: 'role:compute',
      }),
      msg({ id: 'u2', role: 'user', content: 'now write it up', roleRef: 'role:academic' }),
    ];
    const transcript = buildDaemonTranscript(history, 'matos', GROUP);
    expect(transcript).toContain('## group chat context');
    // Roster lists every member and marks the responder.
    expect(transcript).toContain('- Compute (role:compute)');
    expect(transcript).toContain('- Academic Research (role:academic) ← you');
    // Turns carry member attribution so agents can read each other's work.
    expect(transcript).toContain('## user (@Compute)\nplan the study');
    expect(transcript).toContain('## assistant (member: Compute)\nI ran the relaxations.');
    expect(transcript).toContain('## user (@Academic Research)\nnow write it up');
  });

  it('leaves unattributed turns as bare role headers inside a group', () => {
    const history = [
      msg({ id: 'u1', role: 'user', content: 'kickoff' }),
      msg({ id: 'a1', role: 'assistant', content: 'ok', agentId: 'matos' }),
    ];
    const transcript = buildDaemonTranscript(history, 'matos', GROUP);
    expect(transcript).toContain('## user\nkickoff');
    expect(transcript).toContain('## assistant\nok');
  });

  it('falls back to the ref-derived name for members no longer in the roster', () => {
    const history = [
      msg({
        id: 'a1',
        role: 'assistant',
        content: 'legacy turn',
        agentId: 'matos',
        roleRef: 'role:retired-member',
      }),
    ];
    const transcript = buildDaemonTranscript(history, 'matos', GROUP);
    expect(transcript).toContain('## assistant (member: retired-member)\nlegacy turn');
  });

  it('states the dispatch contract in the header', () => {
    const header = buildGroupContextHeader(GROUP);
    expect(header).toContain('Academic Research (role:academic). Do the work yourself');
    expect(header).toContain('You cannot run other members yourself.');
    expect(header).toContain('"@NAME: <what they should do>"');
    // Auto-relay contract: trailing handoff lines dispatch those members.
    expect(header).toContain('dispatched automatically');
    expect(header).toContain('one handoff line per teammate');
    // Every dispatched task doubles as the member's DM work-ledger entry.
    expect(header).toContain('work ledger');
  });

  it('lists member responsibilities in the roster when briefs exist', () => {
    const header = buildGroupContextHeader({
      members: [
        { ref: 'role:compute', name: 'Compute', brief: '负责 DFT 计算与算力调度' },
        { ref: 'role:academic', name: 'Academic Research' },
      ],
      respondingRef: 'role:compute',
      respondingName: 'Compute',
    });
    expect(header).toContain('- Compute (role:compute) ← you — 负责 DFT 计算与算力调度');
    expect(header).toContain('- Academic Research (role:academic)');
  });

  it('annotates group turns with attached and produced file references', () => {
    const history = [
      msg({
        id: 'u1',
        role: 'user',
        content: '@Compute 弛豫这个结构，@Academic Research 复核参数',
        roleRef: 'role:compute',
        attachments: [
          { path: 'inputs/BaTiO3.cif', name: 'BaTiO3.cif', kind: 'file' },
        ],
      }),
      msg({
        id: 'a1',
        role: 'assistant',
        content: '弛豫完成，结果在 relax-results/。',
        agentId: 'matos',
        roleRef: 'role:compute',
        producedFiles: [
          { name: 'relax-results/OUTCAR', size: 1, mtime: 1, kind: 'binary', mime: 'application/octet-stream' },
          { name: 'relax-results/CONTCAR', size: 1, mtime: 1, kind: 'binary', mime: 'application/octet-stream' },
        ],
      }),
    ];
    const transcript = buildDaemonTranscript(history, 'matos', GROUP);
    // The next member can locate the user's input file and the teammate's
    // outputs by path without the prose restating them.
    expect(transcript).toContain(
      '## user (@Compute)\n@Compute 弛豫这个结构，@Academic Research 复核参数\n[attached files: `inputs/BaTiO3.cif`]',
    );
    expect(transcript).toContain(
      '弛豫完成，结果在 relax-results/。\n[produced files: `relax-results/OUTCAR`, `relax-results/CONTCAR`]',
    );
    // Plain single-role chats stay unannotated: same history, no group context.
    const plain = buildDaemonTranscript(history, 'matos');
    expect(plain).not.toContain('[attached files:');
    expect(plain).not.toContain('[produced files:');
  });

  it('keeps daemon dispatch notices (system rows) out of agent prompts', () => {
    const history = [
      msg({ id: 'u1', role: 'user', content: '@Compute 跑弛豫', roleRef: 'role:compute' }),
      msg({
        id: 'gdn-a1',
        role: 'system',
        content: '交接目标 "@数据分析" 不是本群成员，未派发',
      }),
      msg({ id: 'a1', role: 'assistant', content: '完成。', agentId: 'matos', roleRef: 'role:compute' }),
    ];
    const transcript = buildDaemonTranscript(history, 'matos', GROUP);
    expect(transcript).not.toContain('数据分析');
    expect(transcript).not.toContain('## system');
  });

  it('tells a budget-compacted group run where the full history persists', () => {
    // 45 turns with the 40-message transcript window → 5 omitted.
    const history = Array.from({ length: 45 }, (_, index) =>
      msg({
        id: `m${index}`,
        role: index % 2 === 0 ? 'user' : 'assistant',
        content: `turn ${index}`,
        roleRef: 'role:compute',
        ...(index % 2 === 1 ? { agentId: 'matos' } : {}),
      }));
    const transcript = buildDaemonTranscript(history, 'matos', GROUP);
    expect(transcript).toContain('## Earlier group history compacted');
    expect(transcript).toContain('5 older message(s)');
    // The agent's "scroll up": the project-local native timeline file.
    expect(transcript).toContain('.matos/workbench/project-events.jsonl');
  });

  it('keeps daemon dispatch notices (system rows) out of agent prompts', () => {
    const history = [
      msg({ id: 'u1', role: 'user', content: '@Compute 跑弛豫', roleRef: 'role:compute' }),
      msg({
        id: 'gdn-a1',
        role: 'system',
        content: '交接目标 "@数据分析" 不是本群成员，未派发',
      }),
      msg({ id: 'a1', role: 'assistant', content: '完成。', agentId: 'matos', roleRef: 'role:compute' }),
    ];
    const transcript = buildDaemonTranscript(history, 'matos', GROUP);
    expect(transcript).not.toContain('数据分析');
    expect(transcript).not.toContain('## system');
  });

  it('tells a budget-compacted group run where the full history persists', () => {
    // 45 turns with the 40-message transcript window -> 5 omitted.
    const history = Array.from({ length: 45 }, (_, index) =>
      msg({
        id: `m${index}`,
        role: index % 2 === 0 ? 'user' : 'assistant',
        content: `turn ${index}`,
        roleRef: 'role:compute',
        ...(index % 2 === 1 ? { agentId: 'matos' } : {}),
      }));
    const transcript = buildDaemonTranscript(history, 'matos', GROUP);
    expect(transcript).toContain('## Earlier group history compacted');
    expect(transcript).toContain('5 older message(s)');
    // The agent's "scroll up": the project-local native timeline file.
    expect(transcript).toContain('.matos/workbench/project-events.jsonl');
  });

  it('renders the quote-reply anchor under the turn header', () => {
    const history = [
      msg({
        id: 'a1',
        role: 'assistant',
        content: '弛豫完成，结果在 relax-results/。\n@Academic Research: 整理对照表',
        agentId: 'matos',
        roleRef: 'role:compute',
      }),
      msg({
        id: 'stub-1',
        role: 'user',
        content: '@Academic Research 整理对照表',
        roleRef: 'role:academic',
        replyTo: {
          messageId: 'a1',
          roleRef: 'role:compute',
          authorName: 'Compute',
          excerpt: '弛豫完成，结果在 relax-results/。 @Academic Research: 整理对照表',
        },
      }),
    ];
    const transcript = buildDaemonTranscript(history, 'matos', GROUP);
    // The relayed member sees exactly which teammate reply its task anchors
    // to, even after later turns push that reply up the log.
    expect(transcript).toContain(
      '## user (@Academic Research)\n' +
        '[in reply to Compute: "弛豫完成，结果在 relax-results/。 @Academic Research: 整理对照表"]\n' +
        '@Academic Research 整理对照表',
    );
  });

  it('labels DM rows mirrored from a group chat with their provenance', () => {
    const groupTask = {
      sourceProjectId: 'p1',
      sourceConversationId: 'conv-g',
      sourceConversationTitle: '电池项目群',
      sourceMessageId: 'a1',
      memberRef: 'role:compute',
      memberName: 'Compute',
    };
    const history = [
      msg({ id: 'gtu', role: 'user', content: '@Compute 跑弛豫', groupTask: { ...groupTask, sourceMessageId: 'u1' } }),
      msg({ id: 'gta', role: 'assistant', content: '弛豫完成。', agentId: 'matos', groupTask }),
      msg({ id: 'u2', role: 'user', content: '你刚才干了什么？' }),
    ];
    const transcript = buildDaemonTranscript(history, 'matos');
    expect(transcript).toContain('## user (task dispatched to you in group chat "电池项目群")\n@Compute 跑弛豫');
    expect(transcript).toContain('## assistant (your work record from group chat "电池项目群")\n弛豫完成。');
    expect(transcript).toContain('## user\n你刚才干了什么？');
  });
});

describe('parseGroupRelayTarget', () => {
  const MEMBERS = GROUP.members;

  it('detects a trailing "@NAME: task" handoff and carries the task text', () => {
    const text = 'I finished the relaxations.\n\n@Compute: run the band structure next';
    expect(parseGroupRelayTarget(text, MEMBERS, 'role:academic')).toEqual({
      ref: 'role:compute',
      name: 'Compute',
      task: 'run the band structure next',
    });
  });

  it('matches multi-word member names and full-width colons', () => {
    const text = '结果已经算完。\n@Academic Research：请基于以上数据撰写论文初稿';
    expect(parseGroupRelayTarget(text, MEMBERS, 'role:compute')).toEqual({
      ref: 'role:academic',
      name: 'Academic Research',
      task: '请基于以上数据撰写论文初稿',
    });
  });

  it('accepts role refs and bare role ids as the mention label', () => {
    expect(
      parseGroupRelayTarget('done\n@role:compute: verify', MEMBERS, 'role:academic'),
    ).toEqual({ ref: 'role:compute', name: 'Compute', task: 'verify' });
    expect(
      parseGroupRelayTarget('done\n@compute 请复核', MEMBERS, 'role:academic'),
    ).toEqual({ ref: 'role:compute', name: 'Compute', task: '请复核' });
  });

  it('tolerates light markdown around the handoff line', () => {
    const text = 'Summary above.\n\n- **@Compute: rerun with tighter k-mesh**';
    expect(parseGroupRelayTarget(text, MEMBERS, 'role:academic')).toEqual({
      ref: 'role:compute',
      name: 'Compute',
      task: 'rerun with tighter k-mesh',
    });
  });

  it('never relays to the member that just answered (no self-relay)', () => {
    const text = 'Working on it.\n@Compute: continue the same job';
    expect(parseGroupRelayTarget(text, MEMBERS, 'role:compute')).toBeNull();
  });

  it('ignores mentions buried mid-text (only trailing lines count)', () => {
    const early = '@Compute: please run this first.\n' + 'filler line\n'.repeat(8) + 'All done, no handoff.';
    expect(parseGroupRelayTarget(early, MEMBERS, 'role:academic')).toBeNull();
    const midSentence = 'As @Compute said earlier, the lattice constant is 3.9 Å.';
    expect(parseGroupRelayTarget(midSentence, MEMBERS, 'role:academic')).toBeNull();
  });

  it('returns null for empty replies, unknown names, and single-member rosters', () => {
    expect(parseGroupRelayTarget('', MEMBERS, 'role:academic')).toBeNull();
    expect(parseGroupRelayTarget('@Nobody: hi', MEMBERS, 'role:academic')).toBeNull();
    expect(
      parseGroupRelayTarget('@Compute: hi', [{ ref: 'role:compute', name: 'Compute' }], 'role:compute'),
    ).toBeNull();
  });

  it('keeps a bounded relay budget', () => {
    expect(GROUP_RELAY_MAX_HOPS).toBeGreaterThan(0);
    expect(GROUP_RELAY_MAX_HOPS).toBeLessThanOrEqual(5);
  });
});

describe('parseGroupRelayTargets (multi-handoff)', () => {
  const TEAM = [
    { ref: 'role:compute', name: 'Compute' },
    { ref: 'role:academic', name: 'Academic Research' },
    { ref: 'role:modeling', name: 'Modeling' },
  ];

  it('collects every trailing handoff line in written order with task text', () => {
    const text = [
      'Relaxations are done.',
      '',
      '@Modeling: build the ML potential from the relaxed set',
      '@Academic Research: draft the methods section',
    ].join('\n');
    expect(parseGroupRelayTargets(text, TEAM, 'role:compute')).toEqual([
      { ref: 'role:modeling', name: 'Modeling', task: 'build the ML potential from the relaxed set' },
      { ref: 'role:academic', name: 'Academic Research', task: 'draft the methods section' },
    ]);
  });

  it('stops at the first non-handoff line above the trailing block', () => {
    const text = [
      '@Modeling: this one is mid-text and must not count',
      'Summary of what I did.',
      '@Academic Research: write it up',
    ].join('\n');
    expect(parseGroupRelayTargets(text, TEAM, 'role:compute')).toEqual([
      { ref: 'role:academic', name: 'Academic Research', task: 'write it up' },
    ]);
  });

  it('dedupes repeated mentions and never includes the responder', () => {
    const text = [
      'Done.',
      '@Compute: not me',
      '@Modeling: fit the potential',
      '@Modeling: fit the potential again',
    ].join('\n');
    // The bottom-up trailing-block walk keeps the occurrence nearest the end.
    expect(parseGroupRelayTargets(text, TEAM, 'role:compute')).toEqual([
      { ref: 'role:modeling', name: 'Modeling', task: 'fit the potential again' },
    ]);
  });

  it('caps the fan-out at GROUP_DISPATCH_MAX_TARGETS', () => {
    const bigTeam = Array.from({ length: 8 }, (_, i) => ({
      ref: `role:m${i}`,
      name: `M${i}`,
    }));
    const text = bigTeam.map((m) => `@${m.name}: go`).join('\n');
    const targets = parseGroupRelayTargets(text, bigTeam, 'role:none');
    expect(targets.length).toBeLessThanOrEqual(GROUP_DISPATCH_MAX_TARGETS);
  });
});

describe('parseUserGroupMentions', () => {
  const TEAM = [
    { ref: 'role:compute', name: '算力老王' },
    { ref: 'role:academic', name: 'Academic Research' },
  ];

  it('finds every member mentioned anywhere in a typed message', () => {
    const text = '@算力老王 先跑 BaTiO3 的弛豫，@Academic Research 同步查文献。';
    expect(parseUserGroupMentions(text, TEAM)).toEqual([
      { ref: 'role:compute', name: '算力老王' },
      { ref: 'role:academic', name: 'Academic Research' },
    ]);
  });

  it('keeps first-mention order and dedupes', () => {
    const text = '@Academic Research 你先来，@算力老王 之后接手，@Academic Research 最后收尾';
    expect(parseUserGroupMentions(text, TEAM)).toEqual([
      { ref: 'role:academic', name: 'Academic Research' },
      { ref: 'role:compute', name: '算力老王' },
    ]);
  });

  it('accepts role refs and bare ids; ignores unknown names and emails', () => {
    expect(parseUserGroupMentions('@role:compute 走起', TEAM)).toEqual([
      { ref: 'role:compute', name: '算力老王' },
    ]);
    expect(parseUserGroupMentions('@compute 走起', TEAM)).toEqual([
      { ref: 'role:compute', name: '算力老王' },
    ]);
    expect(parseUserGroupMentions('@Nobody hello', TEAM)).toEqual([]);
    expect(parseUserGroupMentions('mail me at a@b.com', TEAM)).toEqual([]);
    expect(parseUserGroupMentions('', TEAM)).toEqual([]);
  });

  it('matches a CJK member name with no space before the task (Feishu style)', () => {
    // No space between the alias and the Chinese task text — the common way
    // Chinese users type mentions. The name boundary must still resolve.
    expect(parseUserGroupMentions('@算力老王跑一下 BaTiO3 的弛豫', TEAM)).toEqual([
      { ref: 'role:compute', name: '算力老王' },
    ]);
    expect(
      parseUserGroupMentions('@算力老王先跑弛豫，@Academic Research同步查文献', TEAM),
    ).toEqual([
      { ref: 'role:compute', name: '算力老王' },
      { ref: 'role:academic', name: 'Academic Research' },
    ]);
  });

  it('does not match a Latin name that is only a prefix of a longer word', () => {
    const latinTeam = [
      { ref: 'role:compute', name: 'Compute' },
      { ref: 'role:academic', name: 'Academic' },
    ];
    // "@Computer" must not resolve to the "Compute" member.
    expect(parseUserGroupMentions('@Computer science is fun', latinTeam)).toEqual([]);
    // A trailing hyphen/digit keeps the Latin token intact, so no match.
    expect(parseUserGroupMentions('@compute-2 run it', latinTeam)).toEqual([]);
  });
});

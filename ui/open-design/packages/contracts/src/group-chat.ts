// MatOS project group chat: the shared mention/handoff grammar.
//
// A project conversation with more than one `role:<id>` member is a
// Feishu-style group. One turn = one addressed member executing a native
// `matos --role` run; coordination happens through the shared transcript:
// the user @-mentions members, and a member hands work to teammates by
// ending its reply with `@NAME: <task>` lines.
//
// BOTH sides of the product parse this grammar:
// - the web client (composer @-bar, first-responder resolution, rendering)
// - the daemon (durable group-task queue: fan-out to extra mentioned
//   members, auto-relay continuation after a member's run settles, and the
//   group-context header given to queued member runs)
// Keeping one implementation here is what guarantees a handoff written by a
// member is dispatched identically whether the finishing run was observed by
// an open browser tab or only by the daemon.

/** Max automatic member→member handoffs chained after one real user turn. */
export const GROUP_RELAY_MAX_HOPS = 3;

/** Max members a single reply/user turn can dispatch (fan-out bound). */
export const GROUP_DISPATCH_MAX_TARGETS = 4;

/** How many trailing non-empty reply lines are scanned for handoff lines.
 *  Sized so a full GROUP_DISPATCH_MAX_TARGETS handoff block plus a few
 *  closing remark lines still fits inside the window. */
const GROUP_RELAY_TAIL_LINES = 8;

export interface GroupChatMember {
  /** Canonical `role:<id>` ref, possibly version-pinned (`role:x@1.0.0`). */
  ref: string;
  /** Display name (project alias when set, else catalog/role name). */
  name: string;
}

/** A member picked out of a mention or handoff line. */
export interface GroupMentionTarget {
  ref: string;
  name: string;
}

/** A handoff target plus the task text after `@NAME:` (may be empty). */
export interface GroupRelayTarget extends GroupMentionTarget {
  task: string;
}

/**
 * MatOS group chat context for one turn: the conversation's member roster and
 * the member addressed to answer. The transcript builders (web and daemon)
 * turn this into an attributed transcript — every member's turns are labeled
 * with their name — plus a roster header telling the responding agent who its
 * teammates are and how to hand work to them. This is the group's
 * mutual-discovery mechanism: agents read each other's turns through the
 * shared conversation instead of a second runtime or side channel.
 */
export interface ChatGroupContext {
  /** `brief` is the project's per-member responsibility note (who does what). */
  members: Array<{ ref: string; name: string; brief?: string }>;
  respondingRef: string;
  respondingName: string;
}

/** `role:compute@0.2.0` -> `role:compute` (version-agnostic identity). */
function refIdentity(ref: string): string {
  const trimmed = ref.trim();
  const at = trimmed.indexOf('@');
  return at >= 0 ? trimmed.slice(0, at) : trimmed;
}

function sameRef(a: string | null | undefined, b: string | null | undefined): boolean {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  return refIdentity(a) === refIdentity(b);
}

export function buildGroupContextHeader(ctx: ChatGroupContext): string {
  const roster = ctx.members
    .map((member) => {
      const you = sameRef(member.ref, ctx.respondingRef) ? ' ← you' : '';
      const brief = member.brief?.trim() ? ` — ${member.brief.trim()}` : '';
      return `- ${member.name} (${member.ref})${you}${brief}`;
    })
    .join('\n');
  return [
    '## group chat context',
    'This conversation is a department group chat shared by several MatOS agent members, working toward the same project goal.',
    'Members and their responsibilities:',
    roster,
    `The user has @-addressed the latest message to you, ${ctx.respondingName} (${ctx.respondingRef}). Do the work yourself, from this member's perspective, staying inside your own responsibility.`,
    'Attribution in the transcript below: "## assistant (member: NAME)" marks which member produced a turn; "## user (@NAME)" marks whom the user addressed. Treat other members\' turns as teammates\' contributions — read them for context, build on their results, and do not redo work they already completed.',
    'You cannot run other members yourself. To hand work to teammates, end your reply with one handoff line per teammate, each on its own final line, in the form "@NAME: <what they should do>" — each mentioned member is then dispatched automatically, in order (the user can also dispatch members manually). Only add handoff lines for work that genuinely belongs to another member; do not add any when the task is complete.',
    'Each dispatched task is also recorded in that member\'s direct-message page as their work ledger, so make every handoff line a self-contained task description.',
  ].join('\n');
}

/** Match a member label at the head of an @-mention body, tolerant of the
 *  display name, the full role ref, and the bare role id. Returns the member
 *  when a label matches and is followed by a clean boundary: end of text,
 *  whitespace/punctuation, or any non-Latin-word character. The last case
 *  admits the common CJK style without a space ("@算力老王跑一下弛豫") while
 *  still rejecting Latin prefix collisions ("@Computer" never matches a
 *  member named "Compute", and "@compute-2" never matches "compute"). */
function matchMemberLabel(
  body: string,
  members: ReadonlyArray<GroupChatMember>,
): { member: GroupChatMember; label: string } | null {
  const bodyLower = body.toLowerCase();
  // Longest label first so "@Compute Cluster" wins over a "@Compute" member.
  const labeled = members
    .flatMap((member) =>
      [member.name, member.ref, member.ref.replace(/^role:/, '')]
        .filter((label) => label)
        .map((label) => ({ member, label })),
    )
    .sort((a, b) => b.label.length - a.label.length);
  for (const { member, label } of labeled) {
    if (!bodyLower.startsWith(label.toLowerCase())) continue;
    const after = body.slice(label.length);
    if (after === '' || /^[^A-Za-z0-9_-]/.test(after)) {
      return { member, label };
    }
  }
  return null;
}

/** Full result of scanning a finished reply's trailing handoff block. */
export interface GroupRelayParseResult {
  /** Members to dispatch next, in written order (see parseGroupRelayTargets). */
  targets: GroupRelayTarget[];
  /**
   * `@`-labels of colon-shaped trailing handoff lines ("@X: task") whose
   * label matched NO roster member at all — a typo or a non-member. These
   * were clearly written as handoffs, so the daemon surfaces them to the
   * user as a dispatch notice instead of silently dropping the work.
   * Colon-less mentions ("as @someone noted") are never collected. Bounded,
   * deduped, in written order.
   */
  unmatchedHandoffLabels: string[];
}

/**
 * MatOS group chat auto-relay: find the "@NAME: <what they should do>" handoff
 * lines in a finished member turn. Per the group-context contract each handoff
 * is one of the reply's final lines, so only the trailing lines are scanned —
 * an earlier "as @Compute noted…" reference never triggers a dispatch. The
 * member that produced the reply never matches (no self-relay). `targets`
 * holds the members to dispatch next in the order their handoff lines appear
 * (top to bottom), deduped, bounded by GROUP_DISPATCH_MAX_TARGETS; empty when
 * the reply ends without handoffs. Each target carries the handoff line's
 * task text (after the `@NAME` label, stripped of the leading separator) so
 * the dispatch stub — and the member's DM work ledger — stays self-contained.
 */
export function parseGroupRelayDispatch(
  finalText: string,
  members: ReadonlyArray<GroupChatMember>,
  respondingRef: string,
): GroupRelayParseResult {
  const lines = finalText
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const empty: GroupRelayParseResult = { targets: [], unmatchedHandoffLabels: [] };
  if (lines.length === 0) return empty;
  const candidates = members.filter((member) => !sameRef(member.ref, respondingRef));
  if (candidates.length === 0) return empty;
  const tail = lines.slice(-GROUP_RELAY_TAIL_LINES);
  const targets: GroupRelayTarget[] = [];
  const unmatchedHandoffLabels: string[] = [];
  const seen = new Set<string>();
  const seenUnmatched = new Set<string>();
  // The handoff block is the reply's trailing run of "@NAME: task" lines.
  // Walk the tail bottom-up collecting consecutive handoff lines, then
  // restore top-to-bottom order so members dispatch in the written order.
  for (let i = tail.length - 1; i >= 0; i--) {
    // Tolerate light markdown around the handoff (list bullets, quotes, bold).
    const line = (tail[i] ?? '').replace(/^[>*\-\s]+/, '').replace(/\*\*/g, '').trim();
    if (!line.startsWith('@')) {
      // A non-handoff line ends the trailing block once it has started.
      if (targets.length > 0) break;
      continue;
    }
    const match = matchMemberLabel(line.slice(1), candidates);
    if (!match) {
      // A colon-shaped "@label: task" line that matches no member AT ALL is
      // an intended handoff the user should hear about. Lines matching the
      // responder itself (self-handoff) stay silently ignored, as before.
      const unmatched = /^@([^:：]{1,60})[:：]/.exec(line);
      if (unmatched && !matchMemberLabel(line.slice(1), members)) {
        const label = unmatched[1]!.trim();
        if (label && !seenUnmatched.has(label) && unmatchedHandoffLabels.length < GROUP_DISPATCH_MAX_TARGETS) {
          seenUnmatched.add(label);
          unmatchedHandoffLabels.unshift(label);
        }
      }
      continue;
    }
    if (seen.has(match.member.ref)) continue;
    seen.add(match.member.ref);
    const task = line
      .slice(1 + match.label.length)
      .replace(/^[\s:：，,—-]+/, '')
      .trim();
    targets.unshift({ ref: match.member.ref, name: match.member.name, task });
  }
  return {
    targets: targets.slice(0, GROUP_DISPATCH_MAX_TARGETS),
    unmatchedHandoffLabels,
  };
}

/** Back-compat view of parseGroupRelayDispatch: just the dispatch targets. */
export function parseGroupRelayTargets(
  finalText: string,
  members: ReadonlyArray<GroupChatMember>,
  respondingRef: string,
): GroupRelayTarget[] {
  return parseGroupRelayDispatch(finalText, members, respondingRef).targets;
}

/**
 * Back-compat single-target view of parseGroupRelayTargets: the first member
 * the finished reply hands off to, or null.
 */
export function parseGroupRelayTarget(
  finalText: string,
  members: ReadonlyArray<GroupChatMember>,
  respondingRef: string,
): GroupRelayTarget | null {
  return parseGroupRelayTargets(finalText, members, respondingRef)[0] ?? null;
}

/**
 * Feishu-style user @-mentions: every roster member the user explicitly
 * @-mentions anywhere in a typed group message, in first-mention order,
 * deduped, bounded by GROUP_DISPATCH_MAX_TARGETS. Unlike relay handoffs
 * (trailing lines only), a user mention counts wherever it appears — the
 * first mentioned member answers the turn and the rest are dispatched to
 * follow up, so "@小王 做A @小李 做B" assigns both.
 */
export function parseUserGroupMentions(
  text: string,
  members: ReadonlyArray<GroupChatMember>,
): GroupMentionTarget[] {
  if (!text || members.length === 0) return [];
  const targets: GroupMentionTarget[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] !== '@') continue;
    const match = matchMemberLabel(text.slice(i + 1), members);
    if (!match || seen.has(match.member.ref)) continue;
    seen.add(match.member.ref);
    targets.push({ ref: match.member.ref, name: match.member.name });
    if (targets.length >= GROUP_DISPATCH_MAX_TARGETS) break;
  }
  return targets;
}

/**
 * The persisted prompt for a daemon-built dispatch stub. Relay stubs carry
 * the handoff line's task text so the group log row and the member's DM
 * work-ledger entry describe the actual task instead of a bare "continue"
 * marker; the fallback strings are bilingual because daemon-side dispatch
 * has no client locale.
 */
export function buildGroupRelayStubPrompt(target: GroupRelayTarget): string {
  const task = target.task.trim();
  if (task) return `@${target.name} ${task}`;
  return `@${target.name} 请继续处理上面交接给你的任务 (continue the handoff task addressed to you above)`;
}

export function buildGroupFanOutStubPrompt(target: GroupMentionTarget): string {
  return `@${target.name} 请处理上面用户消息中 @你 的部分 (handle the part addressed to you in the user message above)`;
}

/**
 * Feishu users scroll up; agents cannot. When a group transcript drops older
 * turns to fit the prompt budget, this notice tells the agent HOW MANY turns
 * are missing and WHERE the full history persists: the project-local native
 * timeline JSONL, which lives inside the run's own cwd and is therefore
 * directly readable/greppable with normal file tools. Returns '' when
 * nothing was omitted.
 */
export function buildGroupHistoryCompactionNotice(input: {
  omittedCount: number;
  conversationId?: string | null;
}): string {
  if (!Number.isFinite(input.omittedCount) || input.omittedCount <= 0) return '';
  const filterHint = input.conversationId
    ? ` filter records by conversationId "${input.conversationId}";`
    : '';
  return [
    '## Earlier group history compacted',
    `${input.omittedCount} older message(s) are not shown above. The full conversation history persists in the project-local timeline file \`.matos/workbench/project-events.jsonl\` (one JSON record per line with sender, text, refs, and timestamps;${filterHint} readable with normal file tools from the project root). Retrieve older turns from it only when the current task genuinely needs them.`,
  ].join('\n');
}

/** Bounded length of a quote-reply excerpt (see buildReplyExcerpt). */
export const REPLY_EXCERPT_MAX_CHARS = 160;

/**
 * Whitespace-normalized bounded excerpt of a quoted message, suitable for
 * `ChatMessageReplyRef.excerpt`: newlines collapse to spaces so the quote
 * renders as ONE transcript line, and long content elides with an ellipsis.
 */
export function buildReplyExcerpt(content: string): string {
  const normalized = content.replace(/\s+/g, ' ').trim();
  if (normalized.length <= REPLY_EXCERPT_MAX_CHARS) return normalized;
  return `${normalized.slice(0, REPLY_EXCERPT_MAX_CHARS - 1).trimEnd()}…`;
}

/**
 * One-line transcript rendering of a quote-reply: placed directly under the
 * turn's `## role` header, before the content, so the agent reading the
 * transcript knows exactly which earlier message this turn anchors to.
 * A null/absent author name means the quoted turn was the human user's.
 */
export function formatReplyQuote(reply: {
  authorName?: string | null;
  excerpt: string;
}): string {
  const author = reply.authorName?.trim() ? reply.authorName.trim() : 'user';
  const excerpt = reply.excerpt.trim();
  return excerpt
    ? `[in reply to ${author}: "${excerpt}"]`
    : `[in reply to ${author}]`;
}

/** Most file paths one transcript turn annotates before eliding the rest. */
const TURN_FILE_REFERENCE_MAX_ENTRIES = 8;

function turnFilePaths(
  values: ReadonlyArray<unknown> | null | undefined,
  pathOf: (value: unknown) => unknown,
): string[] {
  if (!Array.isArray(values)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const raw = pathOf(value);
    const path = typeof raw === 'string' ? raw.trim() : '';
    if (!path || seen.has(path)) continue;
    seen.add(path);
    out.push(path);
  }
  return out;
}

function turnFileReferenceLine(label: string, paths: string[]): string | null {
  if (paths.length === 0) return null;
  const shown = paths.slice(0, TURN_FILE_REFERENCE_MAX_ENTRIES);
  const elided = paths.length - shown.length;
  const list = shown.map((path) => `\`${path}\``).join(', ');
  return `[${label}: ${list}${elided > 0 ? `, +${elided} more` : ''}]`;
}

/**
 * Compact per-turn file provenance for group transcripts: which files the
 * user attached to a dispatch turn and which project files a member's run
 * produced/modified. In a multi-member conversation this is how the next
 * member finds a teammate's outputs without relying on the reply prose
 * restating every path — references only, never file contents, bounded so
 * long file lists cannot blow the transcript budget. Returns '' when the
 * turn carries no files. Accepts both persisted shapes: attachment entries
 * may be bare path strings or `{ path, name }` objects; produced files carry
 * their project-relative path in `name`.
 */
export function formatTurnFileReferences(input: {
  attachments?: ReadonlyArray<unknown> | null;
  producedFiles?: ReadonlyArray<unknown> | null;
}): string {
  const attached = turnFilePaths(input.attachments, (value) => {
    if (typeof value === 'string') return value;
    if (value && typeof value === 'object') {
      const entry = value as { path?: unknown; name?: unknown };
      return typeof entry.path === 'string' && entry.path ? entry.path : entry.name;
    }
    return null;
  });
  const produced = turnFilePaths(input.producedFiles, (value) => {
    if (value && typeof value === 'object') {
      const entry = value as { name?: unknown; path?: unknown };
      return typeof entry.name === 'string' && entry.name ? entry.name : entry.path;
    }
    return null;
  });
  return [
    turnFileReferenceLine('attached files', attached),
    turnFileReferenceLine('produced files', produced),
  ]
    .filter((line): line is string => Boolean(line))
    .join('\n');
}

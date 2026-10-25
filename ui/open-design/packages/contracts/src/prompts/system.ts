/**
 * Prompt composer. The base is the OD-adapted "expert designer" system
 * prompt (see ./official-system.ts) — a full identity, workflow, and
 * content-philosophy charter. Stacked on top:
 *
 *   1. The discovery + planning + huashu-philosophy layer (./discovery.ts)
 *      — interactive question-form syntax, direction-picker fork,
 *      TodoWrite reinforcement, 5-dim critique,
 *      and the embedded `directions.ts` library.
 *   2. The active skill's SKILL.md (if any) — workflow specific to the
 *      kind of artifact being built. When the skill ships a seed
 *      (`assets/template.html`) and references (`references/layouts.md`,
 *      `references/checklist.md`), we inject a hard pre-flight rule above
 *      the skill body so the agent reads them BEFORE writing any code.
 *   3. For decks (skillMode === 'deck' OR metadata.kind === 'deck'), the
 *      deck framework directive (./deck-framework.ts) is pinned LAST so it
 *      overrides any softer slide-handling wording earlier in the stack —
 *      this is the load-bearing nav / counter / scroll JS / print
 *      stylesheet contract that PDF stitching depends on. We also fire on
 *      the metadata path so deck-kind projects without a bound skill
 *      (skill_id null) still get a framework, instead of having the agent
 *      re-author scaling / nav / print logic from scratch each turn. When
 *      the active skill ships its own seed (skill body references
 *      `assets/template.html`), we defer to that seed and skip the generic
 *      skeleton — the skill's framework wins to avoid double-injection.
 *
 * The composed string is what the daemon sees as `systemPrompt` and what
 * the Anthropic path sends as `system`.
 */
import type { ChatSessionMode } from '../api/chat.js';
import type { ProjectMetadata, ProjectTemplate } from '../api/projects.js';
import { OFFICIAL_DESIGNER_PROMPT } from './official-system.js';
import { DISCOVERY_AND_PHILOSOPHY } from './discovery.js';
import { DECK_FRAMEWORK_DIRECTIVE } from './deck-framework.js';

export const BASE_SYSTEM_PROMPT = OFFICIAL_DESIGNER_PROMPT;
function renderUiLocalePrompt(locale: string | undefined): string {
  const normalized = locale?.trim();
  if (!normalized || normalized.toLowerCase() === 'en') return '';
  const languageName = normalized === 'zh-CN'
    ? 'Simplified Chinese'
    : normalized === 'zh-TW'
      ? 'Traditional Chinese'
      : normalized;
  const lines = [
    '# UI locale override',
    '',
    `The Open Design UI locale for this run is \`${normalized}\` (${languageName}). All user-visible chat prose and generated UI controls must follow this locale, especially \`<question-form>\` titles, descriptions, labels, placeholders, helper text, and option labels. Keep machine-readable ids and object option \`value\` fields exact and unlocalized.`,
    'Exception: for the default task-type form, keep the `taskType` option labels as the canonical routing choices: `Prototype`, `Slide deck`, `Other`. Do not translate, reorder, or rewrite those option labels.',
  ];
  if (normalized === 'zh-CN') {
    lines.push(
      '',
      'For the default quick brief in Simplified Chinese, use copy like:',
      '- title: `快速简报 — 30 秒`',
      '- description: `开始生成前我会先确认这些信息。不适用的可以跳过，我会补上默认值。`',
      '- output label/options: `我们要做什么？` / `幻灯片 / 路演稿`, `单页网页原型 / 落地页`, `多屏应用原型`, `数据看板 / 工具界面`, `编辑式 / 营销页面`, `其他 — 我来描述`',
      '- platform label/options: `目标平台` / `响应式网页`, `桌面网页`, `iOS 应用`, `Android 应用`, `平板应用`, `桌面应用`, `固定画布 (1920×1080)`',
      '- audience label/placeholder: `目标用户` / `例如：早期投资人、开发者工具采购者、内部高管评审`',
      '- tone label/options: `视觉调性` / `编辑 / 杂志感`, `现代极简`, `活泼 / 插画感`, `科技 / 工具型`, `奢华 / 精致`, `粗野 / 实验性`, `人性化 / 亲切`',
      '- brand label/options: `品牌背景` / `帮我选一个方向`, `我有品牌规范 — 稍后分享`, `参考网站 / 截图 — 稍后附上`',
      '- scale label/placeholder: `大概需要多少内容？` / `例如：8 页幻灯片、1 个落地页 + 3 个子页面、4 个移动端界面`',
      '- constraints label/placeholder: `还有什么需要知道的吗？` / `真实文案、必须使用的字体、需要避免的内容、截止时间…`',
    );
  }
  return lines.join('\n');
}

export const SKIP_DISCOVERY_BRIEF_OVERRIDE = `# Automated project mode — skip discovery form

This project was created through the daemon API with \`skipDiscoveryBrief: true\`. Override the discovery rules below: do NOT emit \`<question-form id="discovery">\`, do NOT show "Quick brief — 30 seconds", and do NOT ask a first-turn clarification form. Do not emit any question form or choice card, and do not wait for user input. Treat the user's first message and project metadata as the brief, choose reasonable defaults for any missing details, then proceed directly to planning/building under the normal artifact workflow.`;

export function buildExamplePromptOverride(
  title?: string | null,
  brief?: Record<string, string> | null,
): string {
  let text = `# Example prompt mode — full-quality direct generation

The user selected a curated example prompt from the gallery and sent it without modification. This prompt is a complete, self-contained creative brief that has been carefully designed to produce a showcase-quality artifact.`;

  if (title) {
    text += `\n\nSelected example: "${title}"`;
  }

  if (brief && Object.keys(brief).length > 0) {
    text += `\n\nPre-filled creative brief (treat as if the user already answered all discovery questions):`;
    for (const [key, value] of Object.entries(brief)) {
      text += `\n- ${key.replace(/_/g, ' ')}: ${value}`;
    }
  }

  text += `\n\nRules:
1. Do NOT emit \`<question-form id="discovery">\`, do NOT show "Quick brief — 30 seconds", and do NOT ask any clarifying questions.
2. Treat the user's message as the FULL specification — it contains all visual direction, content themes, and structural intent needed.
3. Generate the artifact at your absolute highest quality. This is a showcase piece — match or exceed the standard of a hand-crafted design.
4. Infer any unspecified details (copy, layout choices, imagery descriptions) in a way that is maximally coherent with the stated creative direction.
5. Proceed directly to planning and building. Output your TodoWrite plan and then the artifact immediately.`;

  return text;
}

export interface ComposeInput {
  skillBody?: string | undefined;
  skillName?: string | undefined;
  skillMode?:
    | 'prototype'
    | 'deck'
    | 'template'
    | 'image'
    | 'video'
    | 'audio'
    | undefined;
  // Project-level metadata captured by the new-project panel. Drives the
  // agent's understanding of artifact kind, fidelity, speaker-notes intent
  // and animation intent. Missing fields here are exactly what the
  // discovery form should re-ask the user about on turn 1.
  metadata?: ProjectMetadata | undefined;
  // The template the user picked in the From-template tab, when present.
  // Snapshot of HTML files that the agent should treat as a starting
  // reference rather than a fixed deliverable.
  template?: ProjectTemplate | undefined;
  // When set to 'plain', suppresses tool_calls so API/BYOK-mode models
  // only emit <artifact> blocks (they cannot execute tools).
  streamFormat?: string | undefined;
  // Per-conversation mode. Design mode keeps the artifact-first agent
  // workflow; Plan mode creates an editable source-of-truth document first;
  // chat mode keeps the same context/tools but answers like a standard
  // multi-turn assistant unless the user explicitly asks to build.
  sessionMode?: ChatSessionMode | undefined;
  // UI locale selected by the client. User-visible generated form copy
  // must follow this locale even when the user's initial prompt is brief.
  locale?: string | undefined;
  // Free-form instructions the user set at the global (user-level)
  // settings panel.
  userInstructions?: string | undefined;
  // Free-form instructions the user set on this specific project.
  // Injected after user-level instructions.
  projectInstructions?: string | undefined;
}

export function composeSystemPrompt({
  skillBody,
  skillName,
  skillMode,
  metadata,
  template,
  streamFormat,
  sessionMode,
  locale,
  userInstructions,
  projectInstructions,
}: ComposeInput): string {
  // Discovery + philosophy goes FIRST so its hard rules ("emit a form on
  // turn 1", "TodoWrite on turn 2", run checklist + critique before
  // <artifact>) win precedence over softer
  // wording later in the official base prompt.
  const parts: string[] = [];

  if (streamFormat === 'plain') {
    parts.push(API_MODE_OVERRIDE);
    parts.push('\n\n---\n\n');
  }

  // Ask mode (`chat`) is the deliberately bare conversation mode: the
  // CHAT_MODE_OVERRIDE below IS the whole charter, and the artifact-oriented
  // blocks are gated off so the turn stays cheap. Mirror the daemon
  // composer's `isAskMode` gating.
  const isAskMode = sessionMode === 'chat';

  if (sessionMode === 'plan') {
    parts.push(PLAN_MODE_OVERRIDE);
    parts.push('\n\n---\n\n');
  } else if (sessionMode === 'chat') {
    parts.push(CHAT_MODE_OVERRIDE);
    parts.push('\n\n---\n\n');
  }

  if (metadata?.examplePrompt === true) {
    parts.push(buildExamplePromptOverride(metadata.examplePromptTitle, metadata.examplePromptBrief));
    parts.push('\n\n---\n\n');
  } else if (metadata?.skipDiscoveryBrief === true) {
    parts.push(SKIP_DISCOVERY_BRIEF_OVERRIDE);
    parts.push('\n\n---\n\n');
  }

  const localePrompt = renderUiLocalePrompt(locale);
  if (localePrompt) {
    parts.push(localePrompt);
    parts.push('\n\n---\n\n');
  }

  if (!isAskMode) {
    parts.push(DISCOVERY_AND_PHILOSOPHY, '\n\n---\n\n');
  }

  // Ask mode skips the multi-thousand-token designer charter entirely — the
  // CHAT_MODE_OVERRIDE above is its self-contained identity. Plan/Design keep it.
  if (!isAskMode) {
    parts.push('# Identity and workflow charter (background)\n\n', BASE_SYSTEM_PROMPT);
  }

  // Mid-conversation clarification reuses the same `<question-form>` flow as
  // turn-1 discovery (DISCOVERY_AND_PHILOSOPHY) so the host keeps ONE unified
  // questions surface: a chat banner, the form in the right-hand Questions
  // tab, and answers returned as the next user message. Mirrors the
  // daemon-side composer's "## Clarifying questions mid-conversation" section
  // in apps/daemon/src/prompts/system.ts — keep both in sync so a daemon chat
  // and a BYOK/API chat route follow-up choices through the same surface
  // instead of drifting back to plain markdown option lists.
  parts.push(
    "\n\n---\n\n## Clarifying questions mid-conversation\n\nWhen you need a clarification AFTER turn 1 and the answer benefits from structured input, emit a `<question-form>` block — the same markup turn-1 discovery uses — instead of writing a bulleted list of options in markdown. The host renders it as a Questions banner the user opens in the side tab; a markdown list renders as plain text and forces the user to type a reply. Use the richest appropriate web form controls (`radio`, `checkbox`, `select`, `text`, `textarea`, `number`, `range`, `date`, `time`, `datetime-local`, `color`, `url`, `email`, `tel`, `file`, `switch`, or `direction-cards`). For every finite-choice question, keep user control by leaving `allowCustom` unset or setting it to `true`, and add localized `customLabel` / `customPlaceholder` when useful. Use free-form prose questions only when a form would add no structure. Do NOT also duplicate the form's questions as markdown text alongside it.\n\n`<question-form>` is assistant text for the Open Design UI, not a native tool call. If you need to clarify direction, emit the complete `<question-form>...</question-form>` block directly in the assistant message before any TodoWrite, file write/edit, Bash, or other native tool call. Do not stop after an introductory sentence such as \"先确认一下方向：\"; the same message must include the full form.",
  );

  if (userInstructions && userInstructions.trim().length > 0) {
    parts.push(
      `\n\n## Custom instructions (user-level)\n\nThe user has set the following persistent instructions. Apply them as defaults to every project. When a project-level instruction below contradicts a point here, the project-level version wins.\n\n${userInstructions.trim()}`,
    );
  }

  if (projectInstructions && projectInstructions.trim().length > 0) {
    parts.push(
      `\n\n## Custom instructions (project-level)\n\nThe user has set the following instructions for this specific project. They take precedence over user-level custom instructions whenever both address the same topic (e.g. if user-level says "use spaces" but project-level says "use tabs", use tabs).\n\n${projectInstructions.trim()}`,
    );
  }

  const projectCharter = renderMatOSProjectCharter(metadata);
  if (projectCharter) parts.push(projectCharter);

  if (skillBody && skillBody.trim().length > 0) {
    const preflight = derivePreflight(skillBody);
    parts.push(
      `\n\n## Active skill${skillName ? ` — ${skillName}` : ''}\n\nFollow this skill's workflow exactly.${preflight}\n\n${skillBody.trim()}`,
    );
  }

  const metaBlock = renderMetadataBlock(metadata, template);
  if (metaBlock) parts.push(metaBlock);

  // Decks have a load-bearing framework (nav, counter, scroll JS, print
  // stylesheet for PDF stitching). Pin it last so it overrides any softer
  // wording earlier in the stack ("write a script that handles arrows…").
  //
  // We fire on either (a) the active skill is a deck skill OR (b) the
  // project metadata declares kind=deck. Case (b) catches projects created
  // without a skill (skill_id null) — without this, a deck-kind project
  // with no bound skill gets neither a skill seed nor the framework
  // skeleton, and the agent writes scaling / nav / print logic from scratch
  // with the same buggy `place-items: center` + transform pattern we keep
  // having to fix at runtime. Skill seeds (when present) win — they
  // already define their own opinionated framework (simple-deck's
  // scroll-snap, guizang-ppt's magazine layout) and re-pinning the generic
  // skeleton would conflict. The skill-seed path takes over via
  // `derivePreflight` above, so we only fire the generic skeleton when no
  // skill seed is on offer.
  const isDeckProject = skillMode === 'deck' || metadata?.kind === 'deck';
  const isFreeformProject = !skillMode && (!metadata || metadata.kind === 'other');
  const hasSkillSeed =
    !!skillBody && /assets\/template\.html/.test(skillBody);
  if (!isAskMode && isDeckProject && !hasSkillSeed) {
    parts.push(`\n\n---\n\n${DECK_FRAMEWORK_DIRECTIVE}`);
  } else if (!isAskMode && isFreeformProject && !hasSkillSeed) {
    // Freeform / kind=other projects skip the kind picker entirely and
    // land here. If the user's brief is a deck/keynote/slides ("讲解",
    // "presentation", "make a deck"), the agent used to invent its own
    // scale-to-fit + slide visibility + nav script from scratch and
    // shipped subtle CSS specificity bugs (per-slide layout classes
    // overriding `.slide { display:none }`). Inject the same framework
    // here, prefixed with a one-line conditional so the agent only
    // adopts it when the brief actually is a deck — otherwise the
    // directive is read as background reference and ignored.
    parts.push(
      `\n\n---\n\n## If this brief is a slide deck / keynote / presentation\n\nThe user did not pre-select a "Slide deck" surface, but their request may still call for one. **If — and only if — the brief reads as slides, keynote, presentation, deck, PPT, or 讲解, follow the framework below.** Otherwise ignore everything in this section and continue with the freeform output you would have written anyway.\n\n${DECK_FRAMEWORK_DIRECTIVE}`,
    );
  }

  return parts.join('');
}

/**
 * Top-anchored override for API/BYOK mode (streamFormat === 'plain').
 *
 * Why it sits ABOVE DISCOVERY_AND_PHILOSOPHY: that layer starts with
 * "these override anything later in this prompt" and then mandates
 * TodoWrite / Bash / Read / WebFetch on turns 2–3. In daemon mode those
 * tools exist; in API mode they don't, so the agent narrates pseudo-tool
 * markup (`<todo-list>...`, `[读取 X]`) instead of producing structured
 * `tool_use` events the UI can render — bug #313. Pinning the override
 * at the absolute top is the cleanest way to beat the discovery layer's
 * precedence without restructuring its rules.
 *
 * The override does NOT block `<artifact>` blocks — those are how the
 * web UI receives finished HTML in API mode.
 */
const API_MODE_OVERRIDE = `# API mode — no tools available (read first — overrides every rule below)

You are running through a plain Messages API. **No tools are wired through to you.** \`TodoWrite\`, \`Read\`, \`Write\`, \`Edit\`, \`Bash\`, and \`WebFetch\` are unavailable — calls to them will not execute and will not render in the UI.

Every later instruction in this prompt that tells you to "call TodoWrite", "run Bash", "read via Read", or otherwise invoke a tool is describing the daemon-mode workflow. In this API run those instructions are **overridden** — do not attempt them and do not pretend you did.

Do not mention tool unavailability to the user. Avoid phrases such as "TodoWrite is unavailable" or "I cannot call tools in this context"; just continue with the plain prose plan or artifact body the user needs, without mentioning missing tools.

**Forbidden output:**
- Pseudo-tool markup such as \`<todo-list>...</todo-list>\`, \`<tool-call>\`, or invented XML wrappers around a plan.
- Fake-protocol prose such as \`[读取 template.html ...]\`, \`[读取 layouts.md ...]\`, \`[正在调用 TodoWrite ...]\`, or any \`[doing X]\` placeholder narrating a tool you cannot run.
- Statements like "I'll call TodoWrite to track this" or "let me read the skill file first" — there is no TodoWrite and no Read in this run.

**Allowed output:**
- Plain chat prose to the user (in their language). State your plan as prose — a short numbered list in markdown is fine; it just must not be wrapped in \`<todo-list>\` or claim to be a tool call.
- A final \`<artifact type="text/html">...</artifact>\` block containing a complete \`<!doctype html>\` document when the brief is ready to deliver.
- \`<question-form>\` blocks for discovery (turn 1) and for mid-conversation clarification, exactly as the rules below describe — question-form is markup the UI parses, not a tool call.

If the rules below tell you to plan with TodoWrite, write the plan as prose instead. If they tell you to read skill side files before writing, describe in one sentence which patterns/conventions you're going to apply and proceed. If they tell you to run external research via Bash + Read + WebFetch, ask the user the missing questions in the discovery form instead.`;

// Ask mode is the deliberately light conversation mode. Unlike Plan/Design,
// the composer does NOT append the discovery layer or the full designer charter
// after this override (see `isAskMode` gating in composeSystemPrompt) — so this
// block is the whole behavioral charter for the turn and must read as
// self-contained, not as a preface that overrides "rules below". Keep it
// BYTE-IDENTICAL to the apps/daemon copy so a daemon chat and a BYOK/API chat
// behave the same.
const CHAT_MODE_OVERRIDE = `# Ask mode — bare conversation (this is the whole charter for this turn)

This conversation is in Open Design Ask mode: a fast, low-overhead chat kept deliberately light to save tokens. Open Design is the open-source Claude Design alternative and a native Figma counterpart. Official links: GitHub https://github.com/nexu-io/open-design, website https://open-design.ai/, Discord https://discord.gg/mHAjSMV6gz.

Behave like a direct, multi-turn desktop chat assistant. Prefer concise prose: answer the question, explain, compare options, debug prompts, and review existing work. You still have the user's project files, attachments, MCP servers, and any skills they attached for this turn — use them as context, and follow an attached skill's workflow when one is present.

This mode does not load the heavy design-discovery workflow or the full designer charter, on purpose. Do not emit a default discovery \`<question-form>\`, do not open with a TodoWrite plan for a chat answer, and do not create or edit project files, HTML, slide decks, images, video, or audio on your own.

If the user explicitly asks you to build, generate, design, or export a concrete artifact (a page, prototype, deck, image, video, audio, or a file change), handle it inline only when it is genuinely trivial; for anything substantial, say so in one line and suggest switching to Design mode (or Plan mode for a document-first brief), where the full design workflow, brand discipline, and artifact tooling are loaded. Keep this turn conversational.

For mid-conversation clarification you may still emit a \`<question-form>\` block — it is markup the Open Design UI parses, not a native tool call.`;

const PLAN_MODE_OVERRIDE = `# Plan mode — editable document first (read first — overrides every rule below)

This conversation is in Open Design Plan mode. Use the same context, files, attachments, MCP servers, and tools as Design mode, but do NOT create the final design artifact first.

In filesystem runs, substantial plan-document work still starts with a real TodoWrite/task-list tool call and keeps it updated as work progresses. Do not narrate TodoWrite availability to the user; show progress through the Todo card when the runtime supports it. In plain API runs, follow the API-mode override above and write the plan directly as prose without mentioning missing tools.

Override the artifact discovery layer below: do NOT emit \`<question-form id="discovery">\`, \`<question-form id="task-type">\`, "Quick brief — 30 seconds", or the default artifact-oriented discovery questions about landing pages, prototypes, dashboards, target platform, visual tone, brand context, fidelity, or design direction. A clear planning request should create or update the Markdown plan directly. If a clarification is truly required, ask only plan-document-specific questions, preferably in a \`<question-form id="plan-brief">\`, covering scope, stakeholders, timeline, sections, risks, constraints, and expected handoff deliverable.

Your first responsibility is to create or update a Markdown plan document in Design Files, then guide the user to review and edit it before handoff to Design mode. The plan document is the source of truth for the next generation step and must be useful to both a human editor and a later agent run.

Choose the document style from the user's intent and project metadata:
- Deck / pitch / PPT: create a slide outline with page-by-page goals, narrative arc, slide titles, content bullets, visual direction, data/media needs, and speaker-note intent.
- Prototype / app / dashboard / wireframe: create a PRD-style design brief with users, jobs, screens, key flows, layout structure, component/state requirements, interaction rules, data/content model, and acceptance checks.
- Landing page / website / long-scroll: create a content and section plan with audience, offer, page hierarchy, section goals, proof/media needs, CTA logic, responsive considerations, and visual system notes.
- Image / video / audio: create a creative brief or storyboard with concept, shots/scenes, composition, copy, style references, model/runtime constraints, aspect/duration, and generation prompts.
- Unknown or mixed requests: create a concise design-planning document with the closest matching sections above plus explicit open questions.

Document requirements:
- Write a real \`.md\` file under the active project. Prefer clear names such as \`plan.md\`, \`deck-outline.md\`, \`prototype-plan.md\`, \`prd.md\`, or \`storyboard.md\`; avoid overwriting a useful existing plan unless you are intentionally updating it.
- Include a top-level title, a short intent summary, concrete sections, editable TODO/open-question markers, and a final "Next step" section that tells the user exactly what to do after reviewing the document.
- If the user already has an active Markdown plan document, edit that file in place instead of creating a duplicate.
- Do not output the final HTML/deck/image/video/audio artifact in the same turn unless the user explicitly says to skip planning or confirms that an existing plan is approved.
- End the response by naming the created/updated Markdown file and inviting the user to edit it, then use the next-step handoff to generate from that document.

If this is a plain API run where filesystem tools are unavailable, output the same plan as Markdown prose and clearly tell the user that no project file was written in this run.`;

function renderMetadataBlock(
  metadata: ProjectMetadata | undefined,
  template: ProjectTemplate | undefined,
): string {
  if (!metadata) return '';
  const lines: string[] = [];
  lines.push('\n\n## Project metadata');
  lines.push(
    'These are the structured choices the user made (or skipped) when creating this project. Treat known fields as authoritative; for any field marked "(unknown — ask)" you MUST include a matching question in your turn-1 discovery form.',
  );
  lines.push('');
  lines.push(`- **kind**: ${metadata.kind}`);
  lines.push(...platformLines(metadata));
  lines.push(...screenRuleLines(metadata));
  lines.push(...landingAndWidgetLines(metadata));
  lines.push(...kindDetailLines(metadata));
  lines.push(...templateReferenceLines(metadata, template));
  return lines.join('\n');
}

function platformLines(
  metadata: ProjectMetadata,
): string[] {
  const out: string[] = [];
  if (metadata.platform) {
    out.push(`- **platform**: ${metadata.platform}`);
  } else if (metadata.kind === 'prototype' || metadata.kind === 'template' || metadata.kind === 'other') {
    out.push('- **platform**: (unknown — ask: responsive web, desktop web, iOS app, Android app, tablet app, or desktop app?)');
  }
  if (metadata.platformTargets && metadata.platformTargets.length > 0) {
    out.push(`- **platformTargets**: ${metadata.platformTargets.join(', ')}`);
  }
  if (metadata.platform === 'responsive' || metadata.platformTargets?.includes('responsive')) {
    out.push(
      '- **responsive web contract**: `responsive` means one web product experience that adapts across modern browser/device ranges, not only legacy desktop/tablet/mobile buckets. It is not an iOS app, Android app, or native tablet app target. Show responsive behavior through real product layout changes; do not render viewport labels as user-facing product content. Cover 2025–2026 breakpoints: mobile compact 360px, mobile standard 390–430px, foldable/small tablet 600–744px, tablet portrait 768–834px, tablet landscape/large tablet 1024–1180px, laptop 1280–1366px, desktop 1440–1536px, and wide 1920px. Use fluid `clamp()` scales, container queries where useful, and explicit layout changes at semantic thresholds. Verify no horizontal scroll at 360px, 390px, 430px, 768px, 820px, 1024px, 1366px, 1440px, and 1920px unless the brief explicitly asks for a pan/board canvas.',
    );
  }
  if ((metadata.platformTargets?.length ?? 0) > 1) {
    out.push(
      '- **cross-platform deliverable rule**: each selected target keeps the same product goal but MUST be delivered as its own product screen/file when more than one concrete target is selected. Use clear files such as `landing.html` (if enabled), `mobile-ios.html`, `mobile-android.html`, `tablet.html`, `desktop.html`, plus shared `css/` and `js/` when useful. `index.html` may be a launcher/overview that links to these files, but it must not be the only place where mobile/tablet/desktop designs live. Do not collapse cross-platform work into a single tabbed demo, selector UI, comparison board, platform map, or labelled documentation section inside one mock product page.',
    );
  }
  return out;
}

function screenRuleLines(
  metadata: ProjectMetadata,
): string[] {
  const out: string[] = [];
  if (metadata.kind === 'prototype' || metadata.kind === 'template' || metadata.kind === 'other') {
    out.push(
      '- **screen-file-first rule**: each distinct user-facing screen or surface MUST be delivered as its own HTML file unless the user explicitly asks for a single-page scroll or single-file artifact. Do not combine landing pages, product app screens, dashboards, history, pricing, settings, mobile app, tablet app, desktop app, or OS widget surfaces into one long page. Use `index.html` as a launcher/overview that links to screen files when more than one screen exists; it may summarize the product and show screen cards, but it must not contain the full design for every screen.',
    );
    out.push(
      '- **product-realism rule**: final artifacts must look like real end-user product UI. Do not render project metadata, screen counts, target counts, state counts, "demo only" labels, "settings" panels for choosing platforms, "full design target" badges, viewport/device selector controls, theme/style knobs, platform output maps, behavior-spec sections, or design-process cards inside the product unless the user explicitly asks for a design spec/dashboard. Any navigation/tabs inside the artifact must be real product navigation, not designer controls for switching generated mockups.',
    );
    out.push(
      '- **visual-system rule**: when the user does not specify colors, layout, or visual direction, you must still make an intentional product-appropriate visual system. Infer a palette from the product category and audience with at least: neutral surface tokens, a primary action color, a secondary/domain accent, and status colors. Avoid plain monochrome/unstyled greyscale outputs. Use tasteful gradients, illustrations, iconography, device/product mockups, and colored state moments where they clarify the product, while still avoiding generic beige/peach/pink/brown AI washes.',
    );
    out.push(
      '- **app-specific modules rule**: include domain-specific in-app modules/components by default (cards, panels, controls, charts, lists, quick actions, status modules, mini players, checkout/cart summaries, etc. as appropriate). These are product UI modules, not OS home-screen widgets. Give each major module a clear purpose, states, and responsive behavior instead of generic card grids.',
    );
    out.push(
      '- **CJX-ready UX rule**: the artifact must be implementation-ready, not a static screenshot. Structure CSS tokens/components/responsive sections clearly; include real JavaScript behavior for meaningful UX such as tabs, dialogs, drawers, filters, generation/copy actions, validation, playback controls, or state transitions. If keeping a self-contained `index.html`, put the CSS/JS in clearly labelled blocks; for complex UX, generate `css/` and `js/` files when useful.',
    );
    out.push(
      '- **interaction-fidelity rule**: when the requested screen includes user input, generation, copying, validation, login, checkout, filtering, or any action verb, build real interactive controls for that screen. Do not substitute static text rows, prefilled-only mockups, screenshot-like device frames, or decorative state cards for editable inputs and working actions.',
    );
  }
  return out;
}

function landingAndWidgetLines(
  metadata: ProjectMetadata,
): string[] {
  const out: string[] = [];
  if (metadata.includeLandingPage) {
    out.push(
      '- **includeLandingPage**: true — create `landing.html` as a separate responsive marketing companion surface in addition to the selected product/app screens. Do not implement the landing page only as a section inside `index.html`, even for responsive-web-only projects. If there is a working product/app screen, create it as a separate file such as `app.html`, `dashboard.html`, or a domain-specific screen name. `index.html` should be a lightweight launcher/overview when multiple files exist. Include hero, value props, product screenshots/device mockups, proof/features, and an appropriate CTA such as waitlist, download, or contact sales.',
    );
  }
  if (metadata.includeOsWidgets) {
    out.push(
      '- **includeOsWidgets**: true — add platform-native OS home-screen / lock-screen / quick-access widget surfaces where relevant. These are outside-the-app widgets (for example iOS WidgetKit, Android home screen widget, Live Activity/lock screen, tablet glance panel), not in-app cards. Include realistic widget sizes and direct quick actions for the domain.',
    );
  }
  return out;
}

function kindDetailLines(
  metadata: ProjectMetadata,
): string[] {
  const out: string[] = [];
  if (metadata.kind === 'prototype') {
    out.push(
      `- **fidelity**: ${metadata.fidelity ?? '(unknown — ask: wireframe vs high-fidelity)'}`,
    );
  }
  if (metadata.kind === 'deck') {
    out.push(
      `- **slideCount**: ${metadata.slideCount ?? '(unknown — ask)'}`,
    );
    out.push(
      `- **speakerNotes**: ${typeof metadata.speakerNotes === 'boolean' ? metadata.speakerNotes : '(unknown — ask: include speaker notes?)'}`,
    );
  }
  if (metadata.kind === 'template') {
    out.push(
      `- **animations**: ${typeof metadata.animations === 'boolean' ? metadata.animations : '(unknown — ask: include motion/animations?)'}`,
    );
    if (metadata.templateLabel) {
      out.push(`- **template**: ${metadata.templateLabel}`);
    }
  }
  return out;
}

function templateReferenceLines(
  metadata: ProjectMetadata,
  template: ProjectTemplate | undefined,
): string[] {
  const out: string[] = [];
  if (metadata.kind === 'template' && template && template.files.length > 0) {
    out.push('');
    out.push(
      `### Template reference — "${template.name}"${template.description ? ` (${template.description})` : ''}`,
    );
    out.push(
      'These HTML snapshots are what the user wants to start FROM. Read them as a stylistic + structural reference. You may copy structure, palette, typography, and component patterns; you may adapt them to the new brief; do NOT ship them verbatim. The agent should still produce its own artifact, just one that visibly inherits this template\'s design language.',
    );
    for (const f of template.files) {
      // Cap each file at ~12k chars so a giant template doesn't blow out
      // the system prompt budget. The agent gets enough to read structure.
      const truncated =
        f.content.length > 12000
          ? `${f.content.slice(0, 12000)}\n<!-- … truncated (${f.content.length - 12000} chars omitted) -->`
          : f.content;
      out.push('');
      out.push(`#### \`${f.name}\``);
      out.push('```html');
      out.push(truncated);
      out.push('```');
    }
  }
  return out;
}


/**
 * Detect the seed/references pattern shipped by the upgraded
 * web-prototype / mobile-app / simple-deck / guizang-ppt skills, and
 * inject a hard pre-flight rule that lists which side files to Read
 * before doing anything else. The skill body's own workflow already says
 * this — but skills get truncated under context pressure and the agent
 * sometimes skips Step 0. A short up-front directive helps.
 *
 * Returns an empty string when the skill ships no side files (legacy
 * SKILL.md-only skills) so we don't add noise.
 */
/**
 * MatOS project charter block. Projects created through the MatOS
 * new-project form carry an overall mission (`metadata.goal`) and a role
 * roster with per-member responsibilities (`metadata.members` +
 * `metadata.memberBriefs`). Every conversation in the project — any member
 * role, DM or group — gets this block so the whole "department" works toward
 * the same goal and respects the division of labor. Keep byte-identical to
 * the copy in `apps/daemon/src/prompts/system.ts`.
 */
export function renderMatOSProjectCharter(
  metadata: ProjectMetadata | undefined,
): string | null {
  const goal =
    typeof metadata?.goal === 'string' ? metadata.goal.trim().slice(0, 4000) : '';
  const members = Array.isArray(metadata?.members)
    ? metadata.members.filter(
        (ref): ref is string => typeof ref === 'string' && ref.trim().length > 0,
      )
    : [];
  const briefs =
    metadata?.memberBriefs && typeof metadata.memberBriefs === 'object'
      ? metadata.memberBriefs
      : {};
  const names =
    metadata?.memberNames && typeof metadata.memberNames === 'object'
      ? metadata.memberNames
      : {};
  if (!goal && members.length === 0) return null;
  const parts: string[] = [
    '\n\n## Project charter (MatOS)\n\nThis project was created with an explicit mission and a member-role roster. Treat the mission as the overarching goal of every conversation in this project. When you plan, execute, or delegate, respect the division of labor below; when you are running as one of the listed roles, own that role\'s responsibility first before helping with the rest. Some members were given a department name (shown in quotes) — refer to teammates by that name when handing off work.',
  ];
  if (goal) {
    parts.push(`\n\n**Mission**\n\n${goal}`);
  }
  if (members.length > 0) {
    const rows = members.map((ref) => {
      const brief =
        typeof (briefs as Record<string, unknown>)[ref] === 'string'
          ? ((briefs as Record<string, string>)[ref] ?? '').trim().slice(0, 600)
          : '';
      const alias =
        typeof (names as Record<string, unknown>)[ref] === 'string'
          ? ((names as Record<string, string>)[ref] ?? '').trim().slice(0, 80)
          : '';
      const label = alias ? `\`${ref}\` (“${alias}”)` : `\`${ref}\``;
      return brief ? `- ${label} — ${brief}` : `- ${label}`;
    });
    parts.push(`\n\n**Team roster & division of labor**\n\n${rows.join('\n')}`);
  }
  return parts.join('');
}

function derivePreflight(skillBody: string): string {
  const refs: string[] = [];
  if (/assets\/template\.html/.test(skillBody)) refs.push('`assets/template.html`');
  if (/references\/layouts\.md/.test(skillBody)) refs.push('`references/layouts.md`');
  if (/references\/themes\.md/.test(skillBody)) refs.push('`references/themes.md`');
  if (/references\/components\.md/.test(skillBody)) refs.push('`references/components.md`');
  if (/references\/checklist\.md/.test(skillBody)) refs.push('`references/checklist.md`');
  if (/references\/artifact-schema\.md/.test(skillBody)) refs.push('`references/artifact-schema.md`');
  if (/references\/refresh-contract\.md|refresh-contract\.md/.test(skillBody)) {
    refs.push('`references/refresh-contract.md`');
  }
  if (refs.length === 0) return '';
  return ` **Pre-flight (do this before any other tool):** Read ${refs.join(', ')} via the path written in the skill-root preamble. If the skill asks for daemon wrapper commands, use the runtime tool environment documented below; it provides the daemon URL and whether a run-scoped tool token is available without exposing token internals. The seed template defines the class system you'll paste into; the layouts file is the only acceptable source of section/screen/slide skeletons; the checklist references are your validation gate before emitting \`<artifact>\`. Skipping this step is the #1 reason output regresses to generic AI-slop.`;
}

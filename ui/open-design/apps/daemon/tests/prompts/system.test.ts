import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { composeSystemPrompt } from '../../src/prompts/system.js';

describe('composeSystemPrompt', () => {
  it('injects Chinese quick brief guidance when the UI locale is zh-CN', () => {
    const prompt = composeSystemPrompt({ locale: 'zh-CN' });

    expect(prompt).toContain('# UI locale override');
    expect(prompt).toContain('`zh-CN` (Simplified Chinese)');
    expect(prompt).toContain('快速简报 — 30 秒');
    expect(prompt).toContain('目标用户');
    expect(prompt).toContain('视觉调性');
    expect(prompt).toContain('Keep machine-readable ids and object option `value` fields exact and unlocalized');
  });

  it('keeps Plan mode tied to the real Todo card in filesystem runs', () => {
    const prompt = composeSystemPrompt({ sessionMode: 'plan' });

    expect(prompt).toContain('# Plan mode — editable document first');
    expect(prompt).toContain('substantial plan-document work still starts with a real TodoWrite/task-list tool call');
    expect(prompt).toContain('show progress through the Todo card');
  });

  it('injects the converged verification policy (no mid-build screenshot looping)', () => {
    const prompt = composeSystemPrompt({});

    // Verification must read as an end-of-turn, single-pass step.
    expect(prompt).toContain('## Verification — converge at the end, in one pass');
    // The hard cap on rendered visual checks — the lever against model
    // self-initiated 6-12x screenshot retry chains that balloon input tokens.
    expect(prompt).toContain('One render check is the budget');
    expect(prompt).toContain('Do not loop');
    // Safety valve: visual verification is converged, NOT removed.
    expect(prompt).toContain('these justify ONE rendered look');
    // Route to the official wrapper, not a self-launched browser.
    expect(prompt).toContain('Do NOT launch your own browser to do this');
  });


  it('picks the visual direction without a brand branch', () => {
    const prompt = composeSystemPrompt({});
    expect(prompt).toContain('## RULE 2 — pick the visual direction yourself');
    expect(prompt).toContain('Pick the best-matching direction yourself from the Direction library below');
    expect(prompt).not.toContain('Branch A');
    expect(prompt).not.toContain('brand_spec');
    expect(prompt).not.toContain('reference_match');
  });


  it('does not add the responsive web contract to deck metadata without platform fields', () => {
    const prompt = composeSystemPrompt({
      metadata: {
        kind: 'deck',
        speakerNotes: true,
        slideCount: '10-15 pages',
      } as any,
    });

    expect(prompt).toContain('- **kind**: deck');
    expect(prompt).toContain('- **slideCount**: 10-15 pages');
    expect(prompt).not.toContain('**responsive web contract**');
    expect(prompt).not.toContain('**platformTargets**');
  });

  it('tells artifact generation to summarize instead of dumping raw HTML source into chat', () => {
    const prompt = composeSystemPrompt({
      metadata: { kind: 'prototype', fidelity: 'production' } as any,
    });

    expect(prompt).toContain('Do not dump the full raw HTML source back into chat');
    expect(prompt).toContain('the assistant message should only summarize the result');
  });

  describe('artifact handoff no-emit clauses (#1143)', () => {
    it('drops the absolute "non-negotiable" framing in favor of conditional language', () => {
      const prompt = composeSystemPrompt({});
      expect(prompt).not.toContain('non-negotiable output rule');
    });

    it('includes the "When NOT to emit <artifact>" sub-section', () => {
      const prompt = composeSystemPrompt({});
      expect(prompt).toContain('When NOT to emit `<artifact>`');
    });

    it('pins filesystem artifact handoff for non-MatOS prompt composition', () => {
      const prompt = composeSystemPrompt({ agentId: 'other-agent' });
      expect(prompt).toContain('## Filesystem handoff');
      expect(prompt).toContain('filesystem execution profile');
      expect(prompt).toContain("runtime's native tool-call interface");
      expect(prompt).toContain('Never type a tool invocation into assistant text');
      expect(prompt).toContain('This tool-call rule does not apply to MatOS UI markup');
      expect(prompt).toContain('emit the complete `<question-form>...</question-form>` block directly');
      expect(prompt).toContain('Do not output generated source code in a `<artifact type="text/html">...</artifact>` block.');
    });

    it('prioritizes question forms over native tool calls for non-MatOS prompt composition', () => {
      const prompt = composeSystemPrompt({ agentId: 'other-agent' });
      expect(prompt).toContain('## Clarifying questions mid-conversation');
      expect(prompt).toContain('`<question-form>` is assistant text for the MatOS UI, not a native tool call');
      expect(prompt).toContain(
        'emit the complete `<question-form>...</question-form>` block directly in the assistant message before any TodoWrite, file write/edit, Bash, or other native tool call',
      );
      expect(prompt).toContain('Do not stop after an introductory sentence such as "先确认一下方向："');
    });

    it('pins filesystem artifact handoff for other CLI agents too', () => {
      const prompt = composeSystemPrompt({ agentId: 'gemini' });
      expect(prompt).toContain('## Filesystem handoff');
      expect(prompt).toContain("runtime's native tool-call interface");
    });

    it('does not pin filesystem artifact handoff in plain API mode', () => {
      const prompt = composeSystemPrompt({ agentId: 'deepseek', streamFormat: 'plain' });
      expect(prompt).not.toContain('## Filesystem handoff');
    });

    it('forbids wrapping in-place-edit-only turns in an artifact block', () => {
      const prompt = composeSystemPrompt({});
      expect(prompt).toMatch(/filesystem runs/i);
      expect(prompt).toMatch(/Do not emit a source-code `<artifact>` block/i);
    });

    it('forbids putting prose / summaries / paths inside an artifact block', () => {
      const prompt = composeSystemPrompt({});
      expect(prompt).toMatch(/summar(y|ies)|prose|file path/i);
      expect(prompt).toContain('Never wrap a summary, prose, file path reference, bash output, explanation, or full source file inside `<artifact>`.');
    });

    it('does not carry unconditional "Emit single <artifact>" / "emit a single <artifact>" lines anywhere in the composed prompt', () => {
      const prompt = composeSystemPrompt({});
      // Discovery layer used to carry hard-rule unconditional emit instructions
      // (plan template step 9, default arc Turn 3+ recap, deck workflow step 7).
      // Those must be conditional now — otherwise the no-emit exception in the
      // base prompt is overridden by the higher-priority discovery layer.
      expect(prompt).not.toMatch(/^- 9\.\s+Emit single <artifact>\s*$/m);
      expect(prompt).not.toMatch(/emit a single `?<artifact>`?\.\s*$/m);
      expect(prompt).not.toMatch(/^7\.\s+Emit single <artifact>\s*$/m);
    });

    it('declares filesystem file handoff at the dominant discovery layer', () => {
      const prompt = composeSystemPrompt({});
      // The base prompt is lower precedence than DISCOVERY_AND_PHILOSOPHY, so
      // filesystem handoff must be stated at the dominant layer too.
      expect(prompt).toMatch(/Filesystem handoff is canonical/i);
      expect(prompt).toMatch(/Do not emit a source-code `<artifact>` block/i);
    });

    it('also keeps deck-mode prompts free of the unconditional emit line (DECK_FRAMEWORK_DIRECTIVE only stacks for deck projects)', () => {
      // The plain composeSystemPrompt({}) call does NOT include
      // DECK_FRAMEWORK_DIRECTIVE; that directive only stacks when
      // `skillMode === 'deck'` or `metadata.kind === 'deck'`. So if
      // deck-framework.ts:327 ever regresses back to "Emit single <artifact>",
      // a no-args negative assertion is a false negative — exercise the deck
      // path explicitly here.
      const deckPrompt = composeSystemPrompt({ skillMode: 'deck' });
      expect(deckPrompt).not.toMatch(/^7\.\s+Emit single <artifact>\s*$/m);
      expect(deckPrompt).toMatch(/Summarize the written or changed deck file/i);
    });
  });

  describe('connectedExternalMcp directive', () => {
    it('omits the directive when no servers are passed', () => {
      const prompt = composeSystemPrompt({});
      expect(prompt).not.toContain('External MCP servers — already authenticated');
      expect(prompt).not.toContain('mcp__<server>__authenticate');
    });

    it('omits the directive when an empty array is passed', () => {
      const prompt = composeSystemPrompt({ connectedExternalMcp: [] });
      expect(prompt).not.toContain('External MCP servers — already authenticated');
    });

    it('lists each connected server and forbids the synthetic auth tools', () => {
      const prompt = composeSystemPrompt({
        connectedExternalMcp: [
          { id: 'higgsfield-openclaw', label: 'Higgsfield (OpenClaw)' },
          { id: 'github' },
        ],
      });

      expect(prompt).toContain('## External MCP servers — already authenticated');
      expect(prompt).toContain('`higgsfield-openclaw`');
      expect(prompt).toContain('Higgsfield (OpenClaw)');
      expect(prompt).toContain('`github`');
      expect(prompt).toContain(
        '**Do NOT call any tool whose name matches `mcp__<server>__authenticate` or `mcp__<server>__complete_authentication`',
      );
      expect(prompt).toContain('localhost:<random>/callback');
      expect(prompt).toContain('Settings → External MCP');
    });

    it('skips entries with blank ids and emits no directive when nothing usable remains', () => {
      const prompt = composeSystemPrompt({
        connectedExternalMcp: [
          { id: '   ', label: 'blank' },
          { id: '', label: 'empty' },
        ] as any,
      });
      expect(prompt).not.toContain('External MCP servers — already authenticated');
    });

    it('does not duplicate the label when it equals the id', () => {
      const prompt = composeSystemPrompt({
        connectedExternalMcp: [{ id: 'github', label: 'github' }],
      });
      expect(prompt).toContain('- `github`\n');
      expect(prompt).not.toContain('- `github` (github)');
    });

  });


});

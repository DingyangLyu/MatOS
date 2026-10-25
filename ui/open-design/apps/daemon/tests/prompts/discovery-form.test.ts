import { describe, expect, it } from 'vitest';

import { renderDiscoveryAndPhilosophy } from '../../src/prompts/discovery.js';

const DISCOVERY_AND_PHILOSOPHY = renderDiscoveryAndPhilosophy('filesystem');

// The default-router exception in `discovery.ts` emits a single `<question-form
// id="task-type">` on turn 1 that combines the routing question (which Open
// Design workflow to take) with the core discovery brief (audience / brand /
// scale / constraints). Before this consolidation, freeform projects (no Home
// chip pick) saw two clarification cards in a row — task-type, then "Quick
// brief — 30 seconds" — which felt like the agent was re-asking. These tests
// lock the single-shot shape so a future prompt edit cannot accidentally split
// the brief into two turns again.

describe('discovery.ts task-type form (single-shot brief)', () => {
  it('emits a task-type form that asks the routing question plus the discovery brief', () => {
    expect(DISCOVERY_AND_PHILOSOPHY).toContain('<question-form id="task-type"');
    // Task-type radio + the four discovery brief fields must all live in this
    // single form so the user does not see a second clarification card.
    expect(DISCOVERY_AND_PHILOSOPHY).toContain('"id": "taskType"');
    expect(DISCOVERY_AND_PHILOSOPHY).toContain('"id": "audience"');
    expect(DISCOVERY_AND_PHILOSOPHY).toContain('"id": "scale"');
    expect(DISCOVERY_AND_PHILOSOPHY).toContain('"id": "constraints"');
  });

  it('keeps the canonical task-type options', () => {
    const options = [
      'Prototype',
      'Slide deck',
      'Other',
    ];
    for (const option of options) {
      expect(DISCOVERY_AND_PHILOSOPHY).toContain(`"${option}"`);
    }
  });

  it('forbids the agent from emitting a second Quick brief form after task-type answers', () => {
    // The whole point of the consolidation: once turn 1's task-type form is
    // answered, turn 2 must go straight to brand handling / planning. A regex
    // is brittle so check for the explicit no-second-form sentence the prompt
    // ships with.
    expect(DISCOVERY_AND_PHILOSOPHY).toMatch(
      /do NOT emit a second `<question-form id="discovery">` \/ "Quick brief — 30 seconds" form/,
    );
  });

  it('forbids pairing a tailored discovery form with the default Quick brief in one turn', () => {
    expect(DISCOVERY_AND_PHILOSOPHY).toContain('Emit exactly ONE `<question-form>` in this turn.');
    expect(DISCOVERY_AND_PHILOSOPHY).toContain(
      'that tailored form replaces the default "Quick brief — 30 seconds" form; never output both.',
    );
  });

  it('requires the discovery question form before any tool use', () => {
    expect(DISCOVERY_AND_PHILOSOPHY).toContain('No native tool calls');
    expect(DISCOVERY_AND_PHILOSOPHY).toContain(
      'Do not call TodoWrite, write files, or invoke any native tool before emitting the complete `<question-form>...</question-form>` block',
    );
    expect(DISCOVERY_AND_PHILOSOPHY).toContain('the form itself is the next action');
  });

  it('teaches RULE 2 to accept the task-type answer marker alongside discovery', () => {
    expect(DISCOVERY_AND_PHILOSOPHY).toContain('[form answers — task-type]');
    expect(DISCOVERY_AND_PHILOSOPHY).toContain('Proceed directly to RULE 2 and then RULE 3.');
  });
});

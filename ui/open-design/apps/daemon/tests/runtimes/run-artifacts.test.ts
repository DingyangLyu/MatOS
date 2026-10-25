// Unit coverage for `countNewArtifacts`. Pins the v2
// `run_finished.artifact_count` invariant: incremental count of
// distinct artifact paths (HTML + image/video/audio) the run produced
// or modified, deduped by
// path, with Read ops never counted and FAILED ops never counted
// (mrcfps review on PR #2590 — earlier version counted every
// matching `tool_use` regardless of whether the matching
// `tool_result` landed `isError: true`, so a permission-denied
// `Write index.html` still bumped `artifact_count` to 1 and
// corrupted the same funnel this helper is trying to repair).
//
// `server.ts` previously emitted `artifact_count: 0` literally, which
// suppressed every dashboard tile that breaks "generation success" by
// whether an artifact landed. These tests keep the new helper honest
// for the shapes the daemon actually sees on the wire.

import { describe, expect, it } from 'vitest';

import {
  countNewArtifacts,
} from '../../src/runtimes/run-artifacts.js';

let nextId = 0;
function freshId(prefix = 'tool'): string {
  nextId += 1;
  return `${prefix}-${nextId}`;
}

// Helper: emit a tool_use+tool_result pair. `isError` defaults to
// false so the common "successful Write on .html" case stays one
// line at the call site.
function pair(
  name: string,
  filePath: string,
  isError = false,
  id = freshId(),
) {
  return [
    {
      event: 'agent',
      data: {
        type: 'tool_use',
        id,
        name,
        input: { file_path: filePath },
      },
    },
    {
      event: 'agent',
      data: {
        type: 'tool_result',
        toolUseId: id,
        isError,
      },
    },
  ];
}

// Helper: emit a tool_use with no matching tool_result. Used to pin
// the "tool still in flight" / "adapter swallowed result" behavior.
function unfinished(name: string, filePath: string, id = freshId()) {
  return [
    {
      event: 'agent',
      data: {
        type: 'tool_use',
        id,
        name,
        input: { file_path: filePath },
      },
    },
  ];
}

describe('countNewArtifacts', () => {
  it('returns 0 when the run produced no events', () => {
    expect(countNewArtifacts([])).toBe(0);
  });

  it('returns 0 when no tool_use targets an artifact file', () => {
    // .md/.css/.ts are text/code, not artifact outputs; Read never counts.
    expect(
      countNewArtifacts([
        ...pair('Write', '/proj/notes.md'),
        ...pair('Edit', '/proj/styles.css'),
        ...pair('Write', '/proj/app.ts'),
        ...pair('Read', '/proj/index.html'),
      ]),
    ).toBe(0);
  });

  it('counts generated image / video / audio / svg artifacts (not just HTML)', () => {
    // Media-kind projects produce non-HTML outputs; the old HTML-only
    // counter reported a false zero for these. Each distinct media file
    // is one artifact. SVG is a renderable artifact too, so a run that
    // writes only `logo.svg` must count.
    expect(
      countNewArtifacts([
        ...pair('Write', '/proj/hero.png'),
        ...pair('Write', '/proj/promo.mp4'),
        ...pair('Write', '/proj/jingle.mp3'),
        ...pair('Write', '/proj/cover.webp'),
        ...pair('Write', '/proj/logo.svg'),
      ]),
    ).toBe(5);
  });

  it('counts a single successful Write on a .html path', () => {
    expect(
      countNewArtifacts(pair('Write', '/proj/index.html')),
    ).toBe(1);
  });

  it('does NOT count a tool_use whose tool_result reports isError=true', () => {
    // Permission denied, path outside cwd, parent missing — all bounce
    // the same way through the tool_result.isError channel and must
    // not increment artifact_count.
    expect(
      countNewArtifacts(pair('Write', '/proj/index.html', true)),
    ).toBe(0);
  });

  it('does NOT count a tool_use that has no matching tool_result yet', () => {
    // Run was sampled while a Write was still in flight; the
    // safe-default is to undercount rather than promise an
    // artifact we can't confirm landed.
    expect(
      countNewArtifacts(unfinished('Write', '/proj/index.html')),
    ).toBe(0);
  });

  it('dedupes multiple successful Write/Edit ops on the same path', () => {
    expect(
      countNewArtifacts([
        ...pair('Write', '/proj/index.html'),
        ...pair('Edit', '/proj/index.html'),
        ...pair('MultiEdit', '/proj/index.html'),
      ]),
    ).toBe(1);
  });

  it('keeps the path counted when a later edit on the same path fails', () => {
    // First Write succeeded — the artifact exists. A subsequent Edit
    // that errors doesn't take that fact away; the file is still on
    // disk. So this still reports 1.
    expect(
      countNewArtifacts([
        ...pair('Write', '/proj/index.html'),
        ...pair('Edit', '/proj/index.html', true),
      ]),
    ).toBe(1);
  });

  it('counts distinct .html paths separately', () => {
    expect(
      countNewArtifacts([
        ...pair('Write', '/proj/index.html'),
        ...pair('Write', '/proj/about.html'),
        ...pair('Write', '/proj/contact.html'),
      ]),
    ).toBe(3);
  });

  it('handles the Codex `create_file` / `str_replace_edit` aliases', () => {
    expect(
      countNewArtifacts([
        ...pair('create_file', '/proj/a.html'),
        ...pair('str_replace_edit', '/proj/b.html'),
      ]),
    ).toBe(2);
  });

  it('accepts both `file_path` and `path` input shapes', () => {
    const id = freshId();
    expect(
      countNewArtifacts([
        {
          event: 'agent',
          data: {
            type: 'tool_use',
            id,
            name: 'Write',
            input: { path: '/proj/page.html' },
          },
        },
        {
          event: 'agent',
          data: { type: 'tool_result', toolUseId: id, isError: false },
        },
      ]),
    ).toBe(1);
  });

  it('treats .HTML / .Html case-insensitively', () => {
    expect(
      countNewArtifacts([
        ...pair('Write', '/proj/Page.HTML'),
        ...pair('Write', '/proj/Other.Html'),
      ]),
    ).toBe(2);
  });

  it('ignores non-agent events and malformed payloads', () => {
    expect(
      countNewArtifacts([
        { event: 'start', data: { runId: 'r1' } },
        { event: 'stderr', data: { chunk: 'log' } },
        { event: 'agent', data: null },
        { event: 'agent', data: { type: 'text_delta', text: 'hi' } },
        ...pair('Write', '/proj/index.html'),
      ]),
    ).toBe(1);
  });

  it('ignores Read / Grep / Bash even when their input names a .html file', () => {
    expect(
      countNewArtifacts([
        ...pair('Read', '/proj/index.html'),
        ...pair('Grep', '/proj/index.html'),
        ...pair('Bash', '/proj/index.html'),
      ]),
    ).toBe(0);
  });
});

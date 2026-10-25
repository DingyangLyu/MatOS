import { describe, expect, it } from 'vitest';
import { extractKnownProjectFileRefs, lineContainsFileReference } from '../../src/runtime/project-file-references';

describe('project file references', () => {
  it('preserves punctuation, spaces, unicode, Windows paths and overlapping names', () => {
    const names = new Set(['report.csv', 'report.csv.gz', 'data/my report.csv', '结果/合金.txt', 'a[1].csv', 'sub/report.csv']);
    expect(extractKnownProjectFileRefs('Saved report.csv.gz and (report.csv).\n输出：`data/my report.csv`，“结果\\合金.txt”；a[1].csv\nDo not link sub/report.csvx or unrelated-report.csv', names))
      .toEqual(['report.csv.gz', 'report.csv', 'data/my report.csv', 'report.csv', '结果/合金.txt', 'a[1].csv']);
  });

  it('does not invent paths or cross line boundaries', () => {
    expect(extractKnownProjectFileRefs('left\nright.csv\nreport.csvx foo/report.csv', new Set(['left right.csv', 'report.csv', '']))).toEqual([]);
    expect(lineContainsFileReference('./out/report.csv', './out/report.csv')).toBe(true);
    expect(lineContainsFileReference('report.csvx report.csv.', 'report.csv')).toBe(true);
    expect(lineContainsFileReference('prefixreport.csv', 'report.csv')).toBe(false);
  });

  it('agrees with the previous literal boundary rules on mixed paths', () => {
    const names = new Set(['a.csv', 'a.csv.gz', 'sub/a.csv', 'with space/a.csv', 'a[1].csv', './a.csv', '目录/表格.csv', 'x\\y.py', '']);
    const separators = [' ', '/', '-', '.', '。', '`', ':', '（', '）', '(', ')', '\t', '前', ''];
    const content = [...names].flatMap(name => separators.map((before, i) => `${before}${name}${separators[(i + 3) % separators.length]}`)).join('\n');
    const normalize = (value: string) => value.replace(/\\/g, '/').replace(/^\.\//, '');
    const orderedNames = [...names].filter(Boolean).sort((a, b) => b.length - a.length);
    const expected: string[] = [];
    for (const line of content.split(/\r?\n/)) for (const name of orderedNames) {
      const escaped = normalize(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const matched = Boolean(escaped) && new RegExp(`(^|[\\s\`"'“”‘’\\[\\]()<>{}:：,，.。;；!?！？])${escaped}($|[\\s\`"'“”‘’\\[\\]()<>{}:：,，.。;；!?！？])`).test(normalize(line));
      expect(lineContainsFileReference(line, name)).toBe(matched);
      if (matched) expected.push(name);
    }
    expect(extractKnownProjectFileRefs(content, names)).toEqual(expected);
  });

  it('keeps large real-shaped workspaces out of the lines-times-files hot path', () => {
    const names = new Set(Array.from({ length: 80_000 }, (_, i) => `task-s3/src/library-${i}/nested/source-${i}.py`));
    names.add('results/final report.csv');
    const content = Array.from({ length: 260 }, (_, i) => `Step ${i}: validate the calculation and retain the evidence for this experiment.`).join('\n') + '\n已生成 results/final report.csv。';
    const start = performance.now();
    expect(extractKnownProjectFileRefs(content, names)).toEqual(['results/final report.csv']);
    expect(performance.now() - start).toBeLessThan(5_000);
  });
});

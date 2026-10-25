import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(path.join(root, 'apps/web/package.json'));
const yaml = require('yaml') as { parse(text: string): { importers: Record<string, unknown> } };

test('every locked workspace exists and every retained package is locked', () => {
  const lock = yaml.parse(readFileSync(path.join(root, 'pnpm-lock.yaml'), 'utf8'));
  const actual = ['.'];
  for (const parent of ['apps', 'packages', 'tools']) {
    for (const entry of readdirSync(path.join(root, parent), { withFileTypes: true })) {
      if (entry.isDirectory() && existsSync(path.join(root, parent, entry.name, 'package.json'))) {
        actual.push(`${parent}/${entry.name}`);
      }
    }
  }
  const locked = Object.keys(lock.importers).filter(
    (workspace) => workspace === '.' || existsSync(path.join(root, workspace, 'package.json')),
  );
  assert.deepEqual(locked.sort(), actual.sort());
  assert.deepEqual(readdirSync(path.join(root, 'apps')).filter((name) => name !== 'AGENTS.md').sort(), ['daemon', 'web']);
});

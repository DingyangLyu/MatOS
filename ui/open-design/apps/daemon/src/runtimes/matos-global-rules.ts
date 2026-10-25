import { randomUUID } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import path from 'node:path';

// Same bound app-config applies when the rules are saved.
const MAX_RULES_CHARS = 5000;

/**
 * Settings → Instructions "global rules" for a native MatOS run. MatOS owns
 * the system prompt, so the daemon hands the rules to the native host as an
 * extra appended system prompt instead of composing them itself.
 */
export function renderMatOSGlobalRules(rules: string): string {
  return [
    '## User global rules',
    '',
    'The user set these standing instructions in MatOS settings. Follow them throughout this conversation unless the current request or MatOS safety and permission rules require otherwise.',
    '',
    rules.trim().slice(0, MAX_RULES_CHARS),
  ].join('\n');
}

/**
 * Writes the rules for one run attempt and returns the file passed to the
 * native host with --append-system-prompt-file, or null when none are set.
 * Each attempt gets its own file so a same-run retry never shares one.
 */
export async function writeMatOSGlobalRulesFile(
  dataDir: string,
  runId: string,
  customInstructions: unknown,
): Promise<string | null> {
  const rules = typeof customInstructions === 'string' ? customInstructions.trim() : '';
  if (!rules) return null;
  const dir = path.join(dataDir, 'native-run-prompts');
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `${runId.replace(/[^A-Za-z0-9_-]/g, '_')}-${randomUUID()}.md`);
  await fsp.writeFile(file, `${renderMatOSGlobalRules(rules)}\n`, { mode: 0o600 });
  return file;
}

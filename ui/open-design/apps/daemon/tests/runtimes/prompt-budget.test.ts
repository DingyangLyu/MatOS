import { describe, expect, it } from 'vitest';
import { checkPromptArgvBudget, checkWindowsCmdShimCommandLineBudget, checkWindowsDirectExeCommandLineBudget } from '../../src/runtimes/prompt-budget.js';
import { minimalAgentDef } from './helpers/test-helpers.js';

const argvRuntime = minimalAgentDef({ bin: 'matos', maxPromptArgBytes: 2048 });
describe('generic process argument budgets', () => {
  it('measures UTF-8 bytes and allows the exact Windows adapter budget', () => {
    expect(checkPromptArgvBudget(argvRuntime, 'é'.repeat(1024), 'win32')).toBeNull();
    expect(checkPromptArgvBudget(argvRuntime, 'é'.repeat(1025), 'win32')).toMatchObject({ code: 'AGENT_PROMPT_TOO_LARGE', bytes: 2050, limit: 2048 });
  });
  it('uses the larger POSIX argument budget', () => {
    expect(checkPromptArgvBudget(argvRuntime, 'x'.repeat(100000), 'linux')).toBeNull();
    expect(checkPromptArgvBudget(argvRuntime, 'x'.repeat(100001), 'linux')).toMatchObject({ code: 'AGENT_PROMPT_TOO_LARGE' });
  });
  it('does not constrain a runtime whose prompt is delivered outside argv', () => {
    expect(checkPromptArgvBudget(minimalAgentDef({ bin: 'matos' }), 'x'.repeat(200000))).toBeNull();
  });
  it('accounts for quoting when launching Windows shims and executables', () => {
    const args = ['-p', '"'.repeat(20000)];
    expect(checkWindowsCmdShimCommandLineBudget(argvRuntime, 'C:/tools/matos.cmd', args)?.code).toBe('AGENT_PROMPT_TOO_LARGE');
    expect(checkWindowsDirectExeCommandLineBudget(argvRuntime, 'C:/tools/matos.exe', args)?.code).toBe('AGENT_PROMPT_TOO_LARGE');
    expect(checkWindowsCmdShimCommandLineBudget(argvRuntime, 'C:/tools/matos.exe', args)).toBeNull();
    expect(checkWindowsDirectExeCommandLineBudget(argvRuntime, '/tools/matos', args)).toBeNull();
  });
});

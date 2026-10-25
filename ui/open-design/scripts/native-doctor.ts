import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Run from the installed daemon package so every probe loads its actual addon.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repair = process.argv.includes('--repair');
const cwd = resolve(root, 'apps/daemon');
const cache = process.env.MATOS_BUILD_CACHE_DIR || resolve(root, '../../.matos/build-cache');
mkdirSync(resolve(cache, 'tmp'), { recursive: true });
const env = {
  ...process.env,
  TMPDIR: process.env.TMPDIR || resolve(cache, 'tmp'),
  npm_config_cache: process.env.npm_config_cache || resolve(cache, 'npm'),
  npm_config_devdir: process.env.npm_config_devdir || resolve(cache, 'node-gyp'),
  ...(existsSync(resolve(dirname(process.execPath), '../include/node/node.h'))
    ? { npm_config_nodedir: resolve(dirname(process.execPath), '..') } : {}),
};
const probes = [
  {
    name: 'better-sqlite3',
    code: `const D=require('better-sqlite3'); const db=new D(':memory:');
      try { if(db.prepare('select 1 as ok').get().ok!==1) process.exit(1); }
      finally { db.close(); }`,
  },
  {
    name: 'node-pty',
    code: `const p=require('node-pty');
      const child=p.spawn('/bin/sh',['-c','printf matos-native-pty-ok'],
        {name:'xterm',cols:80,rows:24,cwd:process.cwd(),env:process.env});
      let output=''; const timer=setTimeout(()=>{child.kill();process.exit(1)},8000);
      child.onData(s=>output+=s);child.onExit(e=>{
        clearTimeout(timer);
        process.exit(e.exitCode===0&&output.includes('matos-native-pty-ok')?0:1);
      });`,
  },
];
const checks: Array<{ name: string; ok: boolean; repaired: boolean; detail?: string }> = [];
for (const probe of probes) {
  const test = () => spawnSync(process.execPath, ['-e', probe.code], {
    cwd, env, encoding: 'utf8', timeout: 12_000,
  });
  let result = test();
  let repaired = false;
  if (result.status !== 0 && repair) {
    const pnpm = resolve(root, '../../node_modules/pnpm/bin/pnpm.cjs');
    const build = spawnSync(process.execPath, [
      pnpm, '--filter', '@open-design/daemon', 'rebuild', probe.name,
    ], { cwd: root, env, stdio: ['ignore', 'inherit', 'inherit'], timeout: 300_000 });
    result = test();
    repaired = result.status === 0;
    if (build.status !== 0 && !repaired) console.error(`Rebuild of ${probe.name} did not complete successfully.`);
  }
  checks.push({
    name: probe.name, ok: result.status === 0, repaired,
    ...(result.status !== 0 ? {
      detail: String(result.error?.message || result.stderr || 'Native probe failed').slice(0, 1500),
    } : {}),
  });
}
const ok = checks.every(check => check.ok);
console.log(JSON.stringify({
  ok, platform: process.platform, arch: process.arch, node: process.version, checks,
}));
if (!ok) {
  console.error('Native dependencies are not ready. Install a C/C++ build toolchain and Python, then run setup again on this host.');
  process.exitCode = 1;
}

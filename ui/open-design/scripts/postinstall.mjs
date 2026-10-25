import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");

const buildTargets = [
  "packages/release",
  "packages/contracts",
  "packages/components",
  "packages/platform",
  "packages/download",
  "packages/host",
  "packages/agui-adapter",
  "packages/sidecar-proto",
  "packages/launcher-proto",
  "packages/sidecar",
  "packages/diagnostics",
  "apps/daemon",
  "tools/dev",
];

const jsExtensions = new Set([".js", ".cjs", ".mjs"]);

function resolvePackageManagerInvocation() {
  const pnpmExecPath = process.env.npm_execpath;
  if (pnpmExecPath != null && pnpmExecPath.length > 0) {
    if (jsExtensions.has(extname(pnpmExecPath).toLowerCase())) {
      return { argsPrefix: [pnpmExecPath], command: process.execPath };
    }
    return { argsPrefix: [], command: pnpmExecPath };
  }

  return { argsPrefix: [], command: process.platform === "win32" ? "pnpm.cmd" : "pnpm" };
}

const packageManager = resolvePackageManagerInvocation();

function availableBuildTargets() {
  const targets = [];
  for (const target of buildTargets) {
    // Partial install contexts (e.g. a package-only checkout with just
    // apps/daemon/package.json before `pnpm install`) lack the target's sources;
    // building there fails `tsc -p tsconfig.json` with TS5058. Skip instead —
    // such contexts run the real build later, once sources are in place.
    if (!existsSync(resolve(repoRoot, target, "tsconfig.json"))) {
      process.stdout.write(`postinstall: skipping ${target} (no tsconfig.json in this context)\n`);
      continue;
    }
    targets.push(target);
  }
  return targets;
}

function runBuildTargetSync(target) {
  const result = spawnSync(
    packageManager.command,
    [...packageManager.argsPrefix, "-C", target, "run", "build"],
    {
      cwd: repoRoot,
      stdio: "inherit",
    },
  );

  if (result.error != null) {
    throw result.error;
  }

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function runBuildTarget(target) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(
      packageManager.command,
      [...packageManager.argsPrefix, "-C", target, "run", "build"],
      {
        cwd: repoRoot,
        stdio: "inherit",
      },
    );

    child.on("error", rejectPromise);
    child.on("close", (code, signal) => {
      if (code === 0) {
        resolvePromise();
        return;
      }

      const suffix = signal != null ? `signal ${signal}` : `exit code ${code ?? 1}`;
      rejectPromise(new Error(`postinstall: ${target} failed with ${suffix}`));
    });
  });
}

function readPackageJson(target) {
  const req = createRequire(resolve(repoRoot, target, "package.json"));
  return req("./package.json");
}

function workspaceDependencyNames(pkg) {
  const names = new Set();
  for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
    const dependencies = pkg[field];
    if (dependencies == null || typeof dependencies !== "object") continue;
    for (const [name, specifier] of Object.entries(dependencies)) {
      if (typeof specifier === "string" && specifier.startsWith("workspace:")) {
        names.add(name);
      }
    }
  }
  return names;
}

function buildDependencyMap(targets) {
  const targetSet = new Set(targets);
  const nameToTarget = new Map();
  for (const target of targets) {
    const pkg = readPackageJson(target);
    if (typeof pkg.name === "string") {
      nameToTarget.set(pkg.name, target);
    }
  }

  const dependenciesByTarget = new Map();
  for (const target of targets) {
    const pkg = readPackageJson(target);
    const dependencies = [];
    for (const name of workspaceDependencyNames(pkg)) {
      const dependencyTarget = nameToTarget.get(name);
      if (dependencyTarget != null && targetSet.has(dependencyTarget)) {
        dependencies.push(dependencyTarget);
      }
    }
    dependenciesByTarget.set(target, dependencies);
  }
  return dependenciesByTarget;
}

function postinstallConcurrency() {
  const raw = process.env.OPEN_DESIGN_POSTINSTALL_CONCURRENCY;
  if (raw == null || raw.trim() === "") return 1;

  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value < 1) {
    throw new Error(`OPEN_DESIGN_POSTINSTALL_CONCURRENCY must be a positive integer, got: ${raw}`);
  }
  return value;
}

async function runBuildTargetsInParallel(targets, concurrency) {
  const dependenciesByTarget = buildDependencyMap(targets);
  const remaining = new Set(targets);
  const completed = new Set();

  process.stdout.write(
    `postinstall: dependency-aware parallel build enabled (concurrency=${concurrency})\n`,
  );

  while (remaining.size > 0) {
    const ready = targets.filter(
      (target) =>
        remaining.has(target) &&
        dependenciesByTarget.get(target).every((dependency) => completed.has(dependency)),
    );

    if (ready.length === 0) {
      throw new Error(
        `postinstall: could not find a dependency-ready build target; remaining=${[
          ...remaining,
        ].join(", ")}`,
      );
    }

    for (let index = 0; index < ready.length; index += concurrency) {
      const batch = ready.slice(index, index + concurrency);
      process.stdout.write(`postinstall: building ${batch.join(", ")}\n`);
      await Promise.all(batch.map((target) => runBuildTarget(target)));
      for (const target of batch) {
        remaining.delete(target);
        completed.add(target);
      }
    }
  }
}

async function runBuildTargets() {
  const targets = availableBuildTargets();
  const concurrency = postinstallConcurrency();
  if (concurrency <= 1) {
    for (const target of targets) {
      runBuildTargetSync(target);
    }
    return;
  }

  await runBuildTargetsInParallel(targets, concurrency);
}

try {
  await runBuildTargets();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}

// Exercise both lazy native bindings after dependency installation.
const nativeDoctor = spawnSync(process.execPath, [resolve(scriptDir, "native-doctor.ts"), "--repair"], {
  cwd: repoRoot, stdio: "inherit", env: process.env,
});
if (nativeDoctor.error) throw nativeDoctor.error;
if (nativeDoctor.status !== 0) process.exit(nativeDoctor.status ?? 1);

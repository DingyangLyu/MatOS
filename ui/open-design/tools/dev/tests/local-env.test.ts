import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  loadWorkspaceLocalEnv,
  parseDotEnvLocal,
} from "../src/local-env.js";

describe("tools-dev local env loading", () => {
  it("parses common .env.local assignment forms", () => {
    assert.deepEqual({ ...parseDotEnvLocal([
      "# comment",
      "SERVICE_KEY=local",
      "SERVICE_HOST=https://service.example # trailing comment",
      "export SECONDARY_KEY=\"pk local\"",
      "SECONDARY_SECRET='sk#local'",
      "BAD-KEY=ignored",
      "",
    ].join("\n")) }, {
      SERVICE_KEY: "local",
      SERVICE_HOST: "https://service.example",
      SECONDARY_KEY: "pk local",
      SECONDARY_SECRET: "sk#local",
    });
  });

  it("loads workspace .env.local over the parent environment and marks telemetry as local dev", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "od-local-env-"));
    await writeFile(path.join(workspaceRoot, ".env.local"), [
      "SERVICE_KEY=from_file",
      "SECONDARY_KEY=pk_from_file",
    ].join("\n"));
    const env: NodeJS.ProcessEnv = { SERVICE_KEY: "from_parent" };

    const result = loadWorkspaceLocalEnv({ workspaceRoot, env });

    assert.equal(result.loaded, true);
    assert.equal(env.SERVICE_KEY, "from_file");
    assert.equal(env.SECONDARY_KEY, "pk_from_file");
    assert.deepEqual(result.loadedFiles, [".env.local"]);
    assert.deepEqual(result.keys, ["SECONDARY_KEY", "SERVICE_KEY"]);
  });

  it("loads workspace env files in precedence order without overriding higher-priority files", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "od-local-env-"));
    await writeFile(path.join(workspaceRoot, ".env"), "FROM_BASE=base\nSHARED=base\n");
    await writeFile(path.join(workspaceRoot, ".env.development"), "FROM_DEV=dev\nSHARED=dev\n");
    await writeFile(path.join(workspaceRoot, ".env.local"), "FROM_LOCAL=local\nSHARED=local\n");
    await writeFile(path.join(workspaceRoot, ".env.development.local"), "FROM_DEV_LOCAL=dev-local\nSHARED=dev-local\n");
    const logs: string[] = [];
    const env: NodeJS.ProcessEnv = {};

    const result = loadWorkspaceLocalEnv({ workspaceRoot, env, log: (message) => logs.push(message) });

    assert.deepEqual(result.loadedFiles, [".env.development.local", ".env.local", ".env.development", ".env"]);
    assert.equal(env.FROM_DEV_LOCAL, "dev-local");
    assert.equal(env.FROM_LOCAL, "local");
    assert.equal(env.FROM_DEV, "dev");
    assert.equal(env.FROM_BASE, "base");
    assert.equal(env.SHARED, "dev-local");
    assert.deepEqual(logs, ["tools-dev env: loaded .env.development.local, .env.local, .env.development, .env"]);
  });

  it("uses explicit env files instead of default env files", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "od-local-env-"));
    await writeFile(path.join(workspaceRoot, ".env.local"), "DEFAULT_ONLY=yes\n");
    await writeFile(path.join(workspaceRoot, "custom.env"), "CUSTOM_ONLY=yes\n");
    const env: NodeJS.ProcessEnv = {};

    const result = loadWorkspaceLocalEnv({ args: ["--env-file", "custom.env"], workspaceRoot, env });

    assert.deepEqual(result.loadedFiles, ["custom.env"]);
    assert.equal(env.CUSTOM_ONLY, "yes");
    assert.equal(env.DEFAULT_ONLY, undefined);
  });

  it("can be disabled with --no-env-file", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "od-local-env-"));
    await writeFile(path.join(workspaceRoot, ".env.local"), "SHOULD_NOT_LOAD=yes\n");
    const env: NodeJS.ProcessEnv = {};

    const result = loadWorkspaceLocalEnv({ args: ["--no-env-file"], workspaceRoot, env });

    assert.equal(result.loaded, false);
    assert.equal(env.SHOULD_NOT_LOAD, undefined);
  });

  it("does not load env files for help output and suppresses logs for json output", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "od-local-env-"));
    await writeFile(path.join(workspaceRoot, ".env.local"), "VALUE=yes\n");
    const helpEnv: NodeJS.ProcessEnv = {};

    const helpResult = loadWorkspaceLocalEnv({ args: ["--help"], workspaceRoot, env: helpEnv });

    assert.equal(helpResult.loaded, false);
    assert.equal(helpEnv.VALUE, undefined);

    const logs: string[] = [];
    loadWorkspaceLocalEnv({ args: ["status", "--json"], workspaceRoot, env: {}, log: (message) => logs.push(message) });

    assert.deepEqual(logs, []);
  });

  it("requires explicitly requested env files to exist", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "od-local-env-"));

    assert.throws(
      () => loadWorkspaceLocalEnv({ args: ["--env-file", "missing.env"], workspaceRoot, env: {} }),
      /env file not found: missing\.env/,
    );
  });


});

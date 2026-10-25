import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { decideMatOSToolSelection } from "../surfaces/toolSelection.js";
import { ensureMatOSAlgorithmWorkflowIntegration } from "../workflowIntegration.js";
import { matOSAlgorithmRunManifestDigest } from "../manifest.js";
import {
  appendMatOSAlgorithmOutcome,
  matOSAlgorithmOutcomeLedgerPath,
  readMatOSAlgorithmOutcomes,
  readMatOSAlgorithmOutcomesStrict,
} from "./ledger.js";
import { recordWorkflowAlgorithmOutcome } from "./workflowOutcome.js";
import type { MatOSAlgorithmOutcomeRecord } from "./types.js";
import { withMatOSWorkflowExecutionContext } from "../../workflows/executionContext.js";
import {
  appendWorkflowEvent,
  createWorkflowRun,
  readWorkflowRun,
  writeNodeAttempt,
} from "../../workflows/workflowStore.js";
import {
  updateRunStatus,
  writeNodeRun,
} from "../../workflows/runState.js";

function outcomeEnv(cwd: string, userId: string): NodeJS.ProcessEnv {
  return {
    MATOS_SCOPE_ID: `user:${userId}`,
    MATOS_USER_ID: userId,
    MATOS_RUNTIME_DATA_DIR: join(cwd, ".matos", "runtime"),
  };
}

function experimentOutcome(
  scopeRef: string,
  outcomeId: string,
): MatOSAlgorithmOutcomeRecord {
  return {
    schemaVersion: 1,
    redacted: true,
    outcomeId,
    generation: 1,
    recordedAt: "2026-07-13T00:00:00.000Z",
    kind: "experiment",
    subject: { experimentId: outcomeId },
    status: "completed",
    success: true,
    decisionRefs: [],
    metrics: {
      accessToken: "sk-12345678901234567890",
      note: "Bearer abcdefghijklmnopqrstuvwxyz",
    },
    scopeRef,
    provenanceRefs: [],
  };
}

async function recordOutcomeInProcess(input: {
  runDir: string;
  snapshot: unknown;
  env: NodeJS.ProcessEnv;
}): Promise<string> {
  const moduleUrl = pathToFileURL(
    join(
      process.cwd(),
      "src",
      "matos",
      "algorithms",
      "outcomes",
      "workflowOutcome.ts",
    ),
  ).href;
  const script = `
    import { recordWorkflowAlgorithmOutcome } from ${JSON.stringify(moduleUrl)}
    const result = await recordWorkflowAlgorithmOutcome({
      runDir: process.env.OUTCOME_RUN_DIR,
      snapshot: JSON.parse(process.env.OUTCOME_SNAPSHOT),
    })
    if (!result) throw new Error('outcome recording failed')
    process.stdout.write(result.outcomeId)
  `;
  return await new Promise<string>((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", script], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ...input.env,
        OUTCOME_RUN_DIR: input.runDir,
        OUTCOME_SNAPSHOT: JSON.stringify(input.snapshot),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(`outcome child exited ${code}: ${stderr}`));
      }
    });
  });
}

describe("workflow algorithm attribution", () => {
  test("persists manifest, decision refs, scoped outcomes, and retry generations", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "matos-algo-outcome-"));
    const workflowsDir = join(cwd, ".matos", "workflows");
    ensureMatOSAlgorithmWorkflowIntegration();
    const definition = {
      schemaVersion: 1 as const,
      name: "attribution-test",
      parameters: {},
      policy: {},
      nodes: [],
      outputs: {},
    };
    const run = await createWorkflowRun({
      workflowsDir,
      workflowRef: "workflow:attribution-test@1.0.0",
      graphSnapshot: definition,
      projectCwd: cwd,
      workspaceDir: cwd,
    });
    await withMatOSWorkflowExecutionContext(
      {
        runId: run.runId,
        runDir: run.dir,
        workflowNodeId: "select-tools",
        attempt: 1,
        projectCwd: cwd,
        scopeRef: "user:local",
      },
      async () => {
        decideMatOSToolSelection({
          roleRef: "role:test@1.0.0",
          allowedTools: ["Read"],
          env: { MATOS_ALGO_TELEMETRY: "0" },
          cwd,
        });
      },
    );
    await updateRunStatus(run.dir, "completed");

    const manifest = JSON.parse(
      await readFile(join(run.dir, "algorithm-manifest.json"), "utf8"),
    ) as { baselineGuaranteed: boolean };
    expect(manifest.baselineGuaranteed).toBe(true);
    const outcomes = await readMatOSAlgorithmOutcomes(
      cwd,
      { runId: run.runId },
      { scopeRef: "user:local" },
    );
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]?.decisionRefs).toHaveLength(1);
    expect(outcomes[0]?.redacted).toBe(true);
    expect(outcomes[0]?.budgetRef).toBe("budget.json");
    expect(outcomes[0]).toMatchObject({
      algorithmPlane: "policy",
      algorithmId: expect.any(String),
      algorithmVersion: expect.any(String),
      configDigest: expect.any(String),
      workflowRunId: run.runId,
      nodeId: "select-tools",
      attempt: 1,
      reward: {
        value: 1,
        attributionMethod: "terminal",
        attributionVersion: "terminal@1",
      },
      decisionAttributions: [
        { credit: 1, attributedValue: 1 },
      ],
      evidenceCompleteness: { status: "complete" },
      trainingEligible: true,
    });
    expect(
      matOSAlgorithmOutcomeLedgerPath(cwd, { scopeRef: "user:local" }),
    ).toContain("/runtime/scopes/users/local/algorithms/outcomes.jsonl");

    await updateRunStatus(run.dir, "running");
    await updateRunStatus(run.dir, "completed");
    const retried = await readMatOSAlgorithmOutcomes(
      cwd,
      { runId: run.runId },
      { scopeRef: "user:local" },
    );
    expect(retried.map((item) => item.generation)).toEqual([1, 2]);
  });

  test("links validation attempts, evaluations, feedback, scientific metrics, and controller outcomes by reference", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "matos-algo-outcome-links-"));
    ensureMatOSAlgorithmWorkflowIntegration();
    const run = await createWorkflowRun({
      workflowsDir: join(cwd, ".matos", "workflows"),
      workflowRef: "workflow:outcome-links@1.0.0",
      graphSnapshot: {
        schemaVersion: 1,
        name: "outcome-links",
        parameters: {},
        policy: {},
        nodes: [
          {
            id: "validate-result",
            type: "validate",
            runtimeType: "guard",
            targetType: "validate",
            dependsOn: [],
          },
        ],
        outputs: {},
      },
      projectCwd: cwd,
      workspaceDir: cwd,
    });
    await withMatOSWorkflowExecutionContext(
      {
        runId: run.runId,
        runDir: run.dir,
        workflowNodeId: "validate-result",
        attempt: 1,
        projectCwd: cwd,
        scopeRef: "user:local",
      },
      async () => {
        decideMatOSToolSelection({
          roleRef: "role:test@1.0.0",
          allowedTools: ["Read"],
          env: { MATOS_ALGO_TELEMETRY: "0" },
          cwd,
        });
      },
    );
    const startedAt = "2026-07-13T01:00:00.000Z";
    await writeNodeAttempt({
      runDir: run.dir,
      nodeId: "validate-result",
      attempt: 1,
      status: "completed",
      startedAt,
      finishedAt: "2026-07-13T01:00:01.000Z",
      output: { ok: true, severity: "info", recommendation: "continue" },
    });
    await writeNodeRun(run.dir, {
      nodeId: "validate-result",
      status: "completed",
      attempts: 1,
      updatedAt: "2026-07-13T01:00:01.000Z",
    });
    const validationEvent = await appendWorkflowEvent(run.dir, {
      type: "workflow.validation.decision",
      data: { nodeId: "validate-result", ok: true },
    });
    const evaluationEvent = await appendWorkflowEvent(run.dir, {
      type: "workflow.evaluation.recorded",
      data: { evaluationRef: "evaluation:event@1" },
    });
    const feedbackEvent = await appendWorkflowEvent(run.dir, {
      type: "matos.feedback.recorded",
      data: { rawText: "must-not-be-copied", feedbackRef: "feedback:event@1" },
    });
    await writeFile(
      join(run.dir, "budget.json"),
      `${JSON.stringify({ totals: { nodeAttempts: 1, totalCostUsd: 0 } })}\n`,
      "utf8",
    );
    await writeFile(
      join(run.dir, "artifacts.json"),
      `${JSON.stringify([
        {
          id: "validation-report",
          path: "evidence/validation.json",
          nodeId: "validate-result",
          source: "validation",
        },
        {
          id: "evaluation-report",
          path: "evidence/evaluation.json",
          source: "evaluation",
        },
      ])}\n`,
      "utf8",
    );
    await mkdir(join(run.dir, "controllers"), { recursive: true });
    await writeFile(
      join(run.dir, "controllers", "finalize.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        finalizedAt: "2026-07-13T01:00:02.000Z",
        providerId: "test-controller",
        providerVersion: "1.0.0",
        result: { outcomeRefs: ["controller:outcome@1"] },
      })}\n`,
      "utf8",
    );
    const outcome = await recordWorkflowAlgorithmOutcome({
      runDir: run.dir,
      snapshot: {
        ...(await readWorkflowRun(run.dir)),
        status: "completed",
        updatedAt: "2026-07-13T01:00:03.000Z",
        outputs: {
          evaluationRefs: ["evaluation:output@1"],
          userFeedbackRefs: ["feedback:output@1"],
          scientificMetrics: { discoveryEfficiency: 0.75, validated: true },
        },
        provenance: {
          source: "manual",
          metadata: { validationRefs: ["validation:external@1"] },
        },
      },
    });

    expect(outcome).toBeDefined();
    expect(outcome?.validationRefs).toEqual(
      expect.arrayContaining([
        "evidence/validation.json",
        `events.jsonl#${validationEvent.id}`,
        "node-runs/validate-result/attempts/1/attempt.json",
        "validation:external@1",
      ]),
    );
    expect(outcome?.evaluationRefs).toEqual(
      expect.arrayContaining([
        "evidence/evaluation.json",
        `events.jsonl#${evaluationEvent.id}`,
        "evaluation:output@1",
      ]),
    );
    expect(outcome?.userFeedbackRefs).toEqual(
      expect.arrayContaining([
        `events.jsonl#${feedbackEvent.id}`,
        "feedback:output@1",
      ]),
    );
    expect(outcome?.controllerOutcomeRefs).toEqual(["controller:outcome@1"]);
    expect(outcome?.metrics).toMatchObject({
      nodeAttempts: 1,
      totalCostUsd: 0,
      discoveryEfficiency: 0.75,
      validated: true,
    });
    expect(outcome?.evidenceCompleteness).toEqual({
      status: "complete",
      reasons: [],
    });
    expect(outcome?.trainingEligible).toBe(true);
    expect(JSON.stringify(outcome)).not.toContain("must-not-be-copied");
  });

  test("marks a declared validation node with missing attempt state as incomplete", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "matos-algo-outcome-missing-validation-"));
    ensureMatOSAlgorithmWorkflowIntegration();
    const run = await createWorkflowRun({
      workflowsDir: join(cwd, ".matos", "workflows"),
      workflowRef: "workflow:missing-validation@1.0.0",
      graphSnapshot: {
        schemaVersion: 1,
        name: "missing-validation",
        parameters: {},
        policy: {},
        nodes: [
          {
            id: "validate-result",
            type: "validate",
            runtimeType: "guard",
            targetType: "validate",
            dependsOn: [],
          },
        ],
        outputs: {},
      },
      projectCwd: cwd,
      workspaceDir: cwd,
    });

    const outcome = await recordWorkflowAlgorithmOutcome({
      runDir: run.dir,
      snapshot: {
        ...(await readWorkflowRun(run.dir)),
        status: "completed",
        updatedAt: "2026-07-13T01:10:00.000Z",
      },
    });

    expect(outcome?.trainingEligible).toBe(false);
    expect(outcome?.evidenceCompleteness).toMatchObject({
      status: "incomplete",
      missingRefs: expect.arrayContaining([
        "node-runs/validate-result/node-run.json",
      ]),
    });
  });

  test("deduplicates concurrent terminal observer calls for one run revision", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "matos-algo-outcome-race-"));
    const run = await createWorkflowRun({
      workflowsDir: join(cwd, ".matos", "workflows"),
      workflowRef: "workflow:outcome-race@1.0.0",
      graphSnapshot: {
        schemaVersion: 1,
        name: "outcome-race",
        parameters: {},
        policy: {},
        nodes: [],
        outputs: {},
      },
      projectCwd: cwd,
      workspaceDir: cwd,
    });
    const terminal = {
      ...(await readWorkflowRun(run.dir)),
      status: "completed" as const,
      updatedAt: "2026-07-13T00:00:00.000Z",
    };

    const results = await Promise.all(
      Array.from({ length: 12 }, () =>
        recordWorkflowAlgorithmOutcome({
          runDir: run.dir,
          snapshot: terminal,
        }),
      ),
    );

    expect(new Set(results.map((item) => item?.outcomeId))).toEqual(
      new Set([`workflow:${run.runId}:1:completed`]),
    );
    expect(
      await readMatOSAlgorithmOutcomes(
        cwd,
        { runId: run.runId },
        { scopeRef: "user:local" },
      ),
    ).toHaveLength(1);
  });

  test("binds normal ledger access to ambient scope and permits explicit admin audit", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "matos-algo-outcome-ledger-"));
    const aliceEnv = outcomeEnv(cwd, "alice");
    const bobEnv = outcomeEnv(cwd, "bob");

    expect(
      await appendMatOSAlgorithmOutcome(
        cwd,
        experimentOutcome("user:alice", "alice-1"),
        { env: aliceEnv },
      ),
    ).toBe(true);
    expect(
      await appendMatOSAlgorithmOutcome(
        cwd,
        experimentOutcome("user:bob", "forged-by-alice"),
        { env: aliceEnv },
      ),
    ).toBe(false);
    expect(
      await appendMatOSAlgorithmOutcome(
        cwd,
        experimentOutcome("user:bob", "bob-1"),
        { env: bobEnv },
      ),
    ).toBe(true);
    const alicePath = matOSAlgorithmOutcomeLedgerPath(cwd, {
      scopeRef: "user:alice",
      env: aliceEnv,
    });
    await appendFile(alicePath, "{truncated-json\n", "utf8");

    const raw = await readFile(alicePath, "utf8");
    expect(raw).not.toContain("sk-12345678901234567890");
    expect(raw).not.toContain("abcdefghijklmnopqrstuvwxyz");
    const alice = await readMatOSAlgorithmOutcomes(
      cwd,
      {},
      { scopeRef: "user:alice", env: aliceEnv },
    );
    const crossScope = await readMatOSAlgorithmOutcomes(
      cwd,
      {},
      { scopeRef: "user:bob", env: aliceEnv },
    );
    const bob = await readMatOSAlgorithmOutcomes(
      cwd,
      {},
      { scopeRef: "user:bob", env: bobEnv },
    );
    const adminAudit = await readMatOSAlgorithmOutcomes(
      cwd,
      {},
      { scopeRef: "user:bob", env: aliceEnv, isAdmin: true },
    );
    expect(alice.map((item) => item.outcomeId)).toEqual(["alice-1"]);
    expect(crossScope).toEqual([]);
    expect(bob.map((item) => item.outcomeId)).toEqual(["bob-1"]);
    expect(adminAudit.map((item) => item.outcomeId)).toEqual(["bob-1"]);
    expect(() =>
      matOSAlgorithmOutcomeLedgerPath(cwd, {
        scopeRef: "user:bob",
        env: aliceEnv,
      }),
    ).toThrow("not the ambient runtime scope");
    expect(alice[0]?.metrics?.accessToken).toBe("[redacted]");
    expect(alice[0]?.metrics?.note).toBe("Bearer [redacted]");
    await expect(
      readMatOSAlgorithmOutcomesStrict(
        cwd,
        {},
        { scopeRef: "user:alice", env: aliceEnv },
      ),
    ).rejects.toMatchObject({ code: "MATOS_OUTCOME_LEDGER_CORRUPT" });
  });

  test("strictly rejects malformed or training-ineligible records before append", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "matos-algo-outcome-invalid-"));
    const env = outcomeEnv(cwd, "alice");
    const base = experimentOutcome("user:alice", "strict-validation");

    expect(
      await appendMatOSAlgorithmOutcome(
        cwd,
        {
          ...base,
          trainingEligible: true,
          algorithmPlane: "optimizer",
          algorithmId: "offline-test",
          algorithmVersion: "1.0.0",
          configDigest: "sha256:config",
          evidenceCompleteness: {
            status: "incomplete",
            reasons: ["evaluation evidence is truncated"],
            truncatedRefs: ["evaluations.jsonl"],
          },
        },
        { env },
      ),
    ).toBe(false);
    expect(
      await appendMatOSAlgorithmOutcome(
        cwd,
        {
          ...base,
          outcomeId: "absolute-runtime-reference",
          runtimeRefs: [join(cwd, "private-runtime.json")],
        },
        { env },
      ),
    ).toBe(false);
    expect(
      await appendMatOSAlgorithmOutcome(
        cwd,
        {
          ...base,
          outcomeId: "absolute-artifact-path",
          artifactRefs: [{ path: join(cwd, "secret-result.json") }],
        },
        { env },
      ),
    ).toBe(false);
    expect(
      await appendMatOSAlgorithmOutcome(
        cwd,
        {
          ...base,
          outcomeId: "invalid-reward-confidence",
          reward: {
            value: 1,
            objectiveRef: "evaluation:test@1",
            attributionMethod: "terminal",
            attributionVersion: "terminal@1",
            confidence: 2,
          },
        },
        { env },
      ),
    ).toBe(false);
    expect(
      await readMatOSAlgorithmOutcomesStrict(
        cwd,
        {},
        { scopeRef: "user:alice", env },
      ),
    ).toEqual([]);
  });

  test("rejects symlinked ledger files and ancestor runtime components", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "matos-algo-outcome-symlink-"));
    const env = outcomeEnv(cwd, "alice");
    expect(
      await appendMatOSAlgorithmOutcome(
        cwd,
        experimentOutcome("user:alice", "alice-1"),
        { env },
      ),
    ).toBe(true);
    const ledgerPath = matOSAlgorithmOutcomeLedgerPath(cwd, {
      scopeRef: "user:alice",
      env,
    });
    const victim = join(cwd, "victim.jsonl");
    await writeFile(victim, "do-not-touch\n", "utf8");
    await rm(ledgerPath);
    await symlink(victim, ledgerPath);

    expect(
      await readMatOSAlgorithmOutcomes(
        cwd,
        {},
        { scopeRef: "user:alice", env },
      ),
    ).toEqual([]);
    expect(
      await appendMatOSAlgorithmOutcome(
        cwd,
        experimentOutcome("user:alice", "alice-2"),
        { env },
      ),
    ).toBe(false);
    expect(await readFile(victim, "utf8")).toBe("do-not-touch\n");

    const ancestorCwd = await mkdtemp(
      join(tmpdir(), "matos-algo-outcome-ancestor-symlink-"),
    );
    const external = await mkdtemp(
      join(tmpdir(), "matos-algo-outcome-external-"),
    );
    await mkdir(join(ancestorCwd, ".matos"), { recursive: true });
    await symlink(external, join(ancestorCwd, ".matos", "runtime"), "dir");
    const ancestorEnv: NodeJS.ProcessEnv = {
      MATOS_SCOPE_ID: "user:alice",
      MATOS_USER_ID: "alice",
    };
    expect(
      await appendMatOSAlgorithmOutcome(
        ancestorCwd,
        experimentOutcome("user:alice", "ancestor-escape"),
        { env: ancestorEnv },
      ),
    ).toBe(false);
    expect(await readdir(external)).toEqual([]);
  });

  test("allows symlinked filesystem ancestors above the runtime boundary", async () => {
    const realCwd = await mkdtemp(join(tmpdir(), "matos-outcome-real-cwd-"));
    const aliasRoot = await mkdtemp(
      join(tmpdir(), "matos-outcome-alias-root-"),
    );
    const cwd = join(aliasRoot, "workspace-link");
    await symlink(realCwd, cwd, "dir");
    const env = outcomeEnv(cwd, "alice");

    expect(
      await appendMatOSAlgorithmOutcome(
        cwd,
        experimentOutcome("user:alice", "ancestor-alias"),
        { env },
      ),
    ).toBe(true);
    expect(
      (
        await readMatOSAlgorithmOutcomesStrict(
          cwd,
          {},
          { scopeRef: "user:alice", env },
        )
      ).map((item) => item.outcomeId),
    ).toEqual(["ancestor-alias"]);
  });

  test("rejects a symlinked run-local outcome directory", async () => {
    const cwd = await mkdtemp(
      join(tmpdir(), "matos-algo-run-outcome-symlink-"),
    );
    const run = await createWorkflowRun({
      workflowsDir: join(cwd, ".matos", "workflows"),
      workflowRef: "workflow:run-outcome-symlink@1.0.0",
      graphSnapshot: {
        schemaVersion: 1,
        name: "run-outcome-symlink",
        parameters: {},
        policy: {},
        nodes: [],
        outputs: {},
      },
      projectCwd: cwd,
      workspaceDir: cwd,
    });
    const external = await mkdtemp(
      join(tmpdir(), "matos-run-outcome-external-"),
    );
    await symlink(external, join(run.dir, "algorithm-outcomes"), "dir");
    const terminal = {
      ...(await readWorkflowRun(run.dir)),
      status: "completed" as const,
      updatedAt: "2026-07-13T00:00:00.000Z",
    };

    expect(
      await recordWorkflowAlgorithmOutcome({
        runDir: run.dir,
        snapshot: terminal,
      }),
    ).toBeUndefined();
    expect(await readdir(external)).toEqual([]);
  });

  test("reconstructs a corrupt index and serializes generation across processes", async () => {
    const cwd = await mkdtemp(
      join(tmpdir(), "matos-algo-outcome-process-race-"),
    );
    const env = outcomeEnv(cwd, "local");
    const run = await createWorkflowRun({
      workflowsDir: join(cwd, ".matos", "workflows"),
      workflowRef: "workflow:outcome-process-race@1.0.0",
      graphSnapshot: {
        schemaVersion: 1,
        name: "outcome-process-race",
        parameters: {},
        policy: {},
        nodes: [],
        outputs: {},
      },
      projectCwd: cwd,
      workspaceDir: cwd,
    });
    const first = {
      ...(await readWorkflowRun(run.dir)),
      status: "completed" as const,
      updatedAt: "2026-07-13T00:00:00.000Z",
    };
    const outcomesDir = join(run.dir, "algorithm-outcomes");
    const indexPath = join(outcomesDir, "index.json");
    expect(
      await recordOutcomeInProcess({ runDir: run.dir, snapshot: first, env }),
    ).toBe(`workflow:${run.runId}:1:completed`);

    await writeFile(indexPath, "{corrupt-index\n", "utf8");
    expect(
      await recordOutcomeInProcess({ runDir: run.dir, snapshot: first, env }),
    ).toBe(`workflow:${run.runId}:1:completed`);
    expect(JSON.parse(await readFile(indexPath, "utf8"))).toMatchObject({
      generation: 1,
      outcomeRefs: ["1-completed.json"],
    });

    await writeFile(indexPath, "{corrupt-again\n", "utf8");
    const second = {
      ...first,
      status: "failed" as const,
      updatedAt: "2026-07-13T00:01:00.000Z",
    };
    const concurrent = await Promise.all(
      Array.from({ length: 6 }, () =>
        recordOutcomeInProcess({ runDir: run.dir, snapshot: second, env }),
      ),
    );
    expect(new Set(concurrent)).toEqual(
      new Set([`workflow:${run.runId}:2:failed`]),
    );
    expect(JSON.parse(await readFile(indexPath, "utf8"))).toMatchObject({
      generation: 2,
      outcomeRefs: ["1-completed.json", "2-failed.json"],
    });
    expect(
      (await readdir(outcomesDir))
        .filter((name) =>
          /^(\d+)-(completed|failed|cancelled)\.json$/.test(name),
        )
        .sort(),
    ).toEqual(["1-completed.json", "2-failed.json"]);
    expect(
      (
        await readMatOSAlgorithmOutcomes(
          cwd,
          { runId: run.runId },
          { scopeRef: "user:local", env },
        )
      ).map((item) => item.outcomeId),
    ).toEqual([
      `workflow:${run.runId}:1:completed`,
      `workflow:${run.runId}:2:failed`,
    ]);
  });

  test("bounds and run-binds attribution while sanitizing artifact paths", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "matos-algo-outcome-bounds-"));
    const run = await createWorkflowRun({
      workflowsDir: join(cwd, ".matos", "workflows"),
      workflowRef: "workflow:outcome-bounds@1.0.0",
      graphSnapshot: {
        schemaVersion: 1,
        name: "outcome-bounds",
        parameters: {},
        policy: {},
        nodes: [],
        outputs: {},
      },
      projectCwd: cwd,
      workspaceDir: cwd,
    });
    const forgedManifestBody = {
      schemaVersion: 1 as const,
      generatedAt: "2026-07-13T00:00:00.000Z",
      runId: "foreign-run",
      workflowRef: "workflow:outcome-bounds@1.0.0",
      baselineGuaranteed: true as const,
      surfaces: [],
      components: [],
      configurationDigest: "forged-but-internally-valid",
    };
    await writeFile(
      join(run.dir, "algorithm-manifest.json"),
      `${JSON.stringify({
        ...forgedManifestBody,
        manifestDigest: matOSAlgorithmRunManifestDigest(forgedManifestBody),
      })}\n`,
      "utf8",
    );
    const decisions = [
      {
        schemaVersion: 1,
        decisionId: "foreign-run-decision",
        at: "2026-07-13T00:00:00.000Z",
        runId: "foreign-run",
        surfaceId: "tool-selection",
        providerId: "foreign",
        source: "default",
      },
      {
        schemaVersion: 1,
        decisionId: "foreign-workflow-decision",
        at: "2026-07-13T00:00:00.000Z",
        runId: run.runId,
        workflowRef: "workflow:foreign@1.0.0",
        surfaceId: "tool-selection",
        providerId: "foreign",
        source: "default",
      },
      {
        schemaVersion: 1,
        decisionId: "shadow-decision",
        at: "2026-07-13T00:00:00.000Z",
        runId: run.runId,
        workflowRef: "workflow:outcome-bounds@1.0.0",
        surfaceId: "tool-selection",
        providerId: "shadow-candidate",
        source: "default",
        applied: false,
      },
      ...Array.from({ length: 600 }, (_, index) => ({
        schemaVersion: 1,
        decisionId: `decision-${index}`,
        at: "2026-07-13T00:00:00.000Z",
        runId: run.runId,
        workflowRef: "workflow:outcome-bounds@1.0.0",
        surfaceId: "tool-selection",
        providerId: "baseline",
        source: "default",
      })),
    ];
    await writeFile(
      join(run.dir, "algorithm-decisions.jsonl"),
      `${decisions.map((item) => JSON.stringify(item)).join("\n")}\n`,
      "utf8",
    );
    await writeFile(
      join(run.dir, "budget.json"),
      `${JSON.stringify({
        totals: Object.fromEntries(
          Array.from({ length: 200 }, (_, index) => [`metric-${index}`, index]),
        ),
      })}\n`,
      "utf8",
    );
    const outsidePath = join(cwd, "host-only", "private-result.json");
    await mkdir(join(cwd, "host-only"), { recursive: true });
    await symlink(join(cwd, "host-only"), join(run.dir, "linked-output"), "dir");

    await writeFile(
      join(run.dir, "artifacts.json"),
      `${JSON.stringify([
        null,
        "not-an-artifact",
        {
          id: "inside",
          path: join(run.dir, "outputs", "result.json"),
          source: "validation",
        },
        {
          id: "outside",
          path: outsidePath,
          source: "validation",
        },
        { id: "symlink-escape", path: join(run.dir, "linked-output", "missing.json") },

        ...Array.from({ length: 600 }, (_, index) => ({
          id: `artifact-${index}`,
          path: `outputs/artifact-${index}.json`,
        })),
      ])}\n`,
      "utf8",
    );
    const terminal = {
      ...(await readWorkflowRun(run.dir)),
      status: "completed" as const,
      updatedAt: "2026-07-13T00:10:00.000Z",
      trace: {
        schemaVersion: 1 as const,
        traceId: "trace-bounded",
        userId: "x".repeat(5 * 1024 * 1024),
      },
    };

    const outcome = await recordWorkflowAlgorithmOutcome({
      runDir: run.dir,
      snapshot: terminal,
    });
    expect(outcome).toBeDefined();
    expect(outcome?.manifestPath).toBeUndefined();
    expect(outcome?.objective).toBeUndefined();
    expect(outcome?.decisionRefs).toHaveLength(512);
    expect(outcome?.decisionRefs).not.toContain("foreign-run-decision");
    expect(outcome?.decisionRefs).not.toContain("foreign-workflow-decision");
    expect(outcome?.decisionRefs).not.toContain("shadow-decision");
    expect(outcome?.counterfactualDecisionRefs).toEqual(["shadow-decision"]);
    expect(outcome?.providerRefs).toHaveLength(512);
    expect(Object.keys(outcome?.metrics ?? {})).toHaveLength(128);
    expect(outcome?.artifactRefs).toHaveLength(512);
    expect(outcome?.artifactRefs?.[0]).toMatchObject({
      id: "inside",
      path: "outputs/result.json",
    });
    expect(outcome?.artifactRefs?.[2]).toMatchObject({
      id: "symlink-escape", path: "[redacted]", redacted: true,
    });
    expect(outcome?.artifactRefs?.[1]).toMatchObject({
      id: "outside",
      path: "[redacted]",
      redacted: true,
    });
    expect(JSON.stringify(outcome)).not.toContain(outsidePath);
    expect(outcome?.trace?.userId).toBeUndefined();
    expect(outcome?.trainingEligible).toBe(false);
    expect(outcome?.evidenceCompleteness).toMatchObject({
      status: "incomplete",
      truncatedRefs: expect.arrayContaining([
        "algorithm-decisions.jsonl",
        "artifacts.json",
        "budget.json",
      ]),
    });
    expect(
      (await stat(join(run.dir, "algorithm-outcomes", "1-completed.json")))
        .size,
    ).toBeLessThanOrEqual(4 * 1024 * 1024);
  });

  test("ignores unsafe or oversized attribution sidecars", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "matos-algo-outcome-sidecars-"));
    const run = await createWorkflowRun({
      workflowsDir: join(cwd, ".matos", "workflows"),
      workflowRef: "workflow:outcome-sidecars@1.0.0",
      graphSnapshot: {
        schemaVersion: 1,
        name: "outcome-sidecars",
        parameters: {},
        policy: {},
        nodes: [],
        outputs: {},
      },
      projectCwd: cwd,
      workspaceDir: cwd,
    });
    const external = await mkdtemp(
      join(tmpdir(), "matos-outcome-sidecars-external-"),
    );
    for (const name of [
      "algorithm-manifest.json",
      "algorithm-decisions.jsonl",
      "budget.json",
    ]) {
      await rm(join(run.dir, name), { force: true });
      const target = join(external, name);
      await writeFile(target, '{"totals":{"leaked":1}}\n', "utf8");
      await symlink(target, join(run.dir, name));
    }
    await writeFile(
      join(run.dir, "artifacts.json"),
      Buffer.alloc(4 * 1024 * 1024 + 1, 0x20),
    );
    const outcome = await recordWorkflowAlgorithmOutcome({
      runDir: run.dir,
      snapshot: {
        ...(await readWorkflowRun(run.dir)),
        status: "completed",
        updatedAt: "2026-07-13T00:20:00.000Z",
      },
    });
    expect(outcome).toBeDefined();
    expect(outcome).toMatchObject({ decisionRefs: [], validationRefs: [] });
    expect(outcome?.manifestPath).toBeUndefined();
    expect(outcome?.budgetRef).toBeUndefined();
    expect(outcome?.artifactRefs).toBeUndefined();
    expect(outcome?.metrics).toBeUndefined();
    expect(outcome?.trainingEligible).toBe(false);
    expect(outcome?.evidenceCompleteness).toMatchObject({
      status: "incomplete",
      corruptRefs: expect.arrayContaining([
        "algorithm-manifest.json",
        "algorithm-decisions.jsonl",
        "budget.json",
        "artifacts.json",
      ]),
    });
  });

  test("does not advance generation from a corrupt high-generation filename", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "matos-algo-outcome-generation-"));
    const run = await createWorkflowRun({
      workflowsDir: join(cwd, ".matos", "workflows"),
      workflowRef: "workflow:outcome-generation@1.0.0",
      graphSnapshot: {
        schemaVersion: 1,
        name: "outcome-generation",
        parameters: {},
        policy: {},
        nodes: [],
        outputs: {},
      },
      projectCwd: cwd,
      workspaceDir: cwd,
    });
    const outcomesDir = join(run.dir, "algorithm-outcomes");
    await mkdir(outcomesDir, { recursive: true });
    await writeFile(join(outcomesDir, "999-completed.json"), "{corrupt\n");

    const outcome = await recordWorkflowAlgorithmOutcome({
      runDir: run.dir,
      snapshot: {
        ...(await readWorkflowRun(run.dir)),
        status: "failed",
        updatedAt: "2026-07-13T00:30:00.000Z",
      },
    });
    expect(outcome?.generation).toBe(1);
    expect(outcome?.outcomeId).toBe(`workflow:${run.runId}:1:failed`);
    expect(await readdir(outcomesDir)).toContain("1-failed.json");
  });
});

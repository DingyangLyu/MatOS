# Running the benchmarks

Build the application with `scripts/matos-setup.sh`. Get each benchmark's public data and install its scientific Python dependencies separately; the MatTools and SciAgentGym environments use Python 3.11.

`scripts/matos-benchmark.sh` is the solver binary for all three harnesses. It pins DeepSeek Flash, full MatOS context and maximum effort, prepares a private DSH profile in each case directory and turns evolution off. Put the provider key in an environment file and export its **absolute** path as `MATOS_BENCH_ENV_FILE`. Each case has a 12-hour solver budget by default.

## MatTools

Set `MATOS_REPO`, `MATTOOLS_ROOT`, `MATTOOLS_PYTHON` and `RUNS` to your source checkout, the MatTools checkout, its Python executable and a new output directory.

```bash
python3 "$MATOS_REPO/scripts/matos-mattools-agentic-bench.py" prepare \
  --mattools-root "$MATTOOLS_ROOT" --mattools-python "$MATTOOLS_PYTHON" \
  --output-root "$RUNS" --run-id matos --json
python3 "$MATOS_REPO/scripts/matos-mattools-agentic-bench.py" run \
  --run-root "$RUNS/matos" --runner matos \
  --matos-bin "$MATOS_REPO/scripts/matos-benchmark.sh" \
  --mattools-root "$MATTOOLS_ROOT" --mattools-python "$MATTOOLS_PYTHON" \
  --matos-model deepseek-flash --provider-model deepseek-flash \
  --effort max --matos-context-profile full --timeout-seconds 43200 --env-file /dev/null --json
python3 "$MATOS_REPO/scripts/matos-mattools-agentic-bench.py" score \
  --run-root "$RUNS/matos" --runner matos \
  --mattools-root "$MATTOOLS_ROOT" --mattools-python "$MATTOOLS_PYTHON" --json
```

Add `--case-id` to `prepare` to run a single case. `adapt` writes a `matos-contract-adapted` submission whose output labels follow the benchmark's contract; score it the same way.

## SciAgentGym

`SCIAGENTGYM_SOURCE` is the directory with the public SciAgentGym repository and data. Put the scientific environment's Python on `PATH`.

```bash
python3 "$MATOS_REPO/scripts/matos-sciagentgym-bench.py" prepare \
  --source-root "$SCIAGENTGYM_SOURCE" --work-root "$RUNS" --run-id matos --json
python3 "$MATOS_REPO/scripts/matos-sciagentgym-bench.py" run \
  --run-root "$RUNS/sciagentgym-chem-materials/runs/matos" \
  --matos-bin "$MATOS_REPO/scripts/matos-benchmark.sh" \
  --model deepseek-flash --context-profile full --timeout 43200 --json
python3 "$MATOS_REPO/scripts/matos-sciagentgym-bench.py" score \
  --run-root "$RUNS/sciagentgym-chem-materials/runs/matos" --json
```

The last command is a deterministic harness check. The official score converts the run into upstream evaluator traces and judges them with DeepSeek Flash, thinking disabled:

```bash
export DEEPSEEK_API_KEY=...   # judge key
"$JUDGE_PYTHON" "$MATOS_REPO/scripts/matos-judge-deepseek-flash.py" \
  "$MATOS_REPO/scripts/sciagentgym-official-eval.py" \
  --source-repo "$SCIAGENTGYM_SOURCE_REPO" \
  --run matos="$RUNS/sciagentgym-chem-materials/runs/matos" \
  --output-root "$RUNS/sciagentgym-official" \
  --answer-source public-richest --judge-model deepseek-flash --json
```

`SCIAGENTGYM_SOURCE_REPO` is the upstream SciAgentGym checkout that provides `EvaluationService`; `JUDGE_PYTHON` needs `openai` and that repository's evaluation dependencies. A case is correct when its official score is at least 1.

## ResearchClawBench

`RCB_ROOT` is the public ResearchClawBench checkout. Prepare a task, run it and freeze the submission:

```bash
python3 "$MATOS_REPO/scripts/matos-rcbench-dsh.py" prepare \
  --task-root "$RCB_ROOT/tasks/Energy_003" \
  --instructions-template "$RCB_ROOT/evaluation/instructions_tmpl.py" \
  --workspace "$RUNS/Energy_003"
python3 "$MATOS_REPO/scripts/matos-rcbench-dsh.py" run --workspace "$RUNS/Energy_003" --timeout-seconds 43200
python3 "$MATOS_REPO/scripts/matos-rcbench-dsh.py" freeze \
  --workspace "$RUNS/Energy_003" --output-root "$RUNS/frozen"
```

The runner gives the original instructions as the task and uses the Research Scientist role. Select a GPU with `--gpu`, and score the frozen submissions with ResearchClawBench's evaluation.

## Asset profiles

`distribution/benchmark-minimal` holds the assets the benchmark runs used, at their original ids, versions and content. The benchmark profile has 28 assets: 2 roles, 5 skills, 18 tools, 1 knowledge note and 2 data records. The workspace profile has 37: it adds the five hidden evolution roles, two skills, a local-calculation workflow and a knowledge note. Export and check a profile with:

```bash
python3 scripts/matos-minimal-assets.py --profile benchmark --output /path/to/new/benchmark-package
bun scripts/matos-minimal-assets-check.ts /path/to/new/benchmark-package/matos-assets benchmark
```

To run against an exported package, set `MATOS_BENCH_ASSET_ROOT` to its absolute `matos-assets` path.

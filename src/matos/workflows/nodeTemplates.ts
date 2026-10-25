/*
 * Copyright 2025 coze-dev Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

// Curated node templates: proven node idioms with parameterized fields.
//
// Skeletons solved structure; templates solve content. Instead of every agent
// re-deriving the same deterministic idioms in its own context (QE wrapper
// invocation, convergence guard stacks, backend lifecycle flags, structured
// agent outputs), each template carries a battle-tested node body where the
// changeable science lives in `{{ parameters.* }}` references. Agents pick a
// template, adjust parameter values, and submit — the boilerplate never
// enters their working context.
//
// Quality bar (enforced by nodeTemplates.test.ts): every template, when
// instantiated into a minimal workflow together with its declared
// parameters, must pass validateWorkflowDefinition. Templates reference
// deployment assets (role:compute, workflow:qe-calculation-evidence,
// /opt/matos-tools paths) that exist in MatOS runtimes; the structural
// validity check does not depend on them.

import type {
  MatOSWorkflowDefinition,
  MatOSWorkflowNode,
  MatOSWorkflowParameter,
} from './types.js'

export type MatOSWorkflowNodeTemplate = {
  id: string
  title: string
  nodeType: string
  description: string
  tags: string[]
  /**
   * Parameter specs referenced by the node body. Instantiation merges them
   * into the workflow's `parameters`, so callers only override values.
   */
  parameters: Record<string, MatOSWorkflowParameter>
  /** Parameterized node body without id/dependsOn (assigned on instantiation). */
  node: Record<string, unknown>
  /** What to change versus what to keep. */
  usage: string
}

const TEMPLATES: MatOSWorkflowNodeTemplate[] = [
  {
    id: 'exec-script',
    title: 'Shell script step (safe defaults)',
    nodeType: 'exec',
    description:
      'Shell execution with strict-mode shell options, artifact-root output, a bounded timeout, and streamed fatal-failure detection.',
    tags: ['general', 'exec'],
    parameters: {},
    node: {
      type: 'exec',
      command: [
        'set -euo pipefail',
        'results_dir="${MATOS_WORKFLOW_ARTIFACT_ROOT:?}"',
        '# TODO: replace the body below; write durable outputs under "$results_dir"',
        'echo "hello from exec-script" > "$results_dir/result.txt"',
      ].join('\n'),
      timeoutSeconds: 3600,
      detectKnownProcessFailures: true,
    },
    usage:
      'Replace the command body after the results_dir line. Keep set -euo pipefail, write durable outputs under $results_dir (the run-scoped artifact root), and keep detectKnownProcessFailures for streamed MPI/OOM/traceback detection. Adjust timeoutSeconds to the real budget.',
  },
  {
    id: 'results-guard',
    title: 'Result-file quality guard',
    nodeType: 'guard',
    description:
      'Standard result gate: the file exists, is non-trivial, and carries no NaN/Infinity sentinels — each check with failureCode and repairHint.',
    tags: ['general', 'guard', 'validate'],
    parameters: {
      results_file: {
        type: 'string',
        default: 'result.txt',
        description:
          'File name under the run artifact root to gate on (pairs with exec-script, which writes there). Parameter values are plain strings — nested templates inside them are not re-expanded.',
      },
    },
    node: {
      type: 'guard',
      checks: [
        {
          type: 'file_exists',
          path: '{{ workflow.artifactRoot }}/{{ parameters.results_file }}',
          failureCode: 'missing_result',
          repairHint: 'The producing node did not write its result file — inspect its output.',
        },
        {
          type: 'file_size',
          path: '{{ workflow.artifactRoot }}/{{ parameters.results_file }}',
          minBytes: 2,
          failureCode: 'empty_result',
          repairHint: 'The result file is empty — the producing step likely failed silently.',
        },
        {
          type: 'regex',
          path: '{{ workflow.artifactRoot }}/{{ parameters.results_file }}',
          pattern: '(NaN|Infinity|-Infinity)',
          negate: true,
          failureCode: 'non_finite_result',
          repairHint: 'A non-finite value reached the result file — fix the calculation instead of passing it through.',
        },
      ],
    },
    usage:
      'Point results_file at the artifact-root file you gate on (exec-script writes there by default). For workspace-relative files, edit the check paths to drop the {{ workflow.artifactRoot }}/ prefix. Keep all three checks; add domain checks (grep for a completion marker, numeric_range on a parsed value) rather than removing the sentinel regex.',
  },
  {
    id: 'agent-analyze',
    title: 'Agent analysis with structured output',
    nodeType: 'agent',
    description:
      'Agent node with the structured-output idiom: an outputSchema so downstream nodes can reference {{ nodes.<id>.outputs.structured.* }} keys instead of parsing prose.',
    tags: ['general', 'agent'],
    parameters: {
      analysis_task: {
        type: 'string',
        default: 'Summarize the computation results and state whether they support the claim.',
        description: 'What the agent should analyze.',
      },
    },
    node: {
      type: 'agent',
      role: 'role:compute',
      prompt: [
        '{{ parameters.analysis_task }}',
        '',
        'Read the workflow artifacts under the artifact root, base every number on the real outputs, and answer as JSON matching the output schema. Missing values stay null — never substitute literature values.',
      ].join('\n'),
      outputSchema: {
        type: 'object',
        properties: {
          summary: { type: 'string' },
          ok: { type: 'boolean' },
          keyNumbers: { type: 'object' },
        },
        required: ['summary', 'ok'],
      },
    },
    usage:
      'Set analysis_task (or replace the prompt) and extend outputSchema with the exact keys downstream nodes need — they become {{ nodes.<id>.outputs.structured.<key> }}. Keep role:compute unless a specialist role is mounted.',
  },
  {
    id: 'human-checkpoint',
    title: 'Human review checkpoint',
    nodeType: 'human',
    description:
      'Pause the run for a human decision with a structured yes/no response contract.',
    tags: ['general', 'human'],
    parameters: {
      review_question: {
        type: 'string',
        default: 'Approve continuing with the computed results?',
        description: 'Question shown to the human reviewer.',
      },
    },
    node: {
      type: 'human',
      prompt: '{{ parameters.review_question }}',
      responseSchema: {
        type: 'object',
        properties: {
          approved: { type: 'boolean' },
          note: { type: 'string' },
        },
        required: ['approved'],
      },
    },
    usage:
      'Set review_question. The run parks in waiting_input until workflow_run action=respond delivers a response; downstream conditions can branch on {{ nodes.<id>.outputs.response.approved }}.',
  },
  {
    id: 'subworkflow-call',
    title: 'Published-workflow call',
    nodeType: 'subworkflow',
    description:
      'Delegate a stage to an already-published workflow asset with explicit parameters — reuse before re-authoring.',
    tags: ['general', 'subworkflow', 'reuse'],
    parameters: {},
    node: {
      type: 'subworkflow',
      workflow: 'workflow:TODO-child-workflow-id',
      parameters: {},
    },
    usage:
      'Set workflow to the published child ref (discover with workflow_query action=list) and pass its parameters. Prefer this over re-authoring: published workflows already carry validated commands and guards.',
  },
  {
    id: 'map-over-items',
    title: 'Bounded parallel map',
    nodeType: 'map',
    description:
      'Fan a published child workflow over a finite item list with bounded parallelism.',
    tags: ['general', 'map', 'parallel'],
    parameters: {
      items: {
        type: 'array',
        default: [],
        description: 'Finite list the child workflow runs over (one child run per item).',
      },
    },
    node: {
      type: 'map',
      workflow: 'workflow:TODO-child-workflow-id',
      items: '{{ parameters.items }}',
      maxParallel: 2,
    },
    usage:
      'Set workflow to the child ref and items to a finite list (each item is exposed to the child as its item parameter context). Keep maxParallel bounded to the real GPU/CPU budget; retry failed children later with workflow_run action=retry_node failedChildrenOnly=true.',
  },
  {
    id: 'qe-pw-exec',
    title: 'Quantum ESPRESSO pw.x run',
    nodeType: 'exec',
    description:
      'pw.x invocation through the MatOS QE wrapper: GPU/CPU profile selection, output capture, and a JOB DONE completion check in one step.',
    tags: ['materials', 'qe', 'dft', 'exec'],
    parameters: {
      qe_input_file: {
        type: 'string',
        required: true,
        description: 'Workspace-relative Quantum ESPRESSO input file (e.g. scf.in).',
      },
      qe_output_file: {
        type: 'string',
        default: 'pw.out',
        description: 'Output log path the run writes and downstream guards read.',
      },
      qe_profile: {
        type: 'string',
        default: 'gpu',
        description: 'MatOS QE wrapper profile: gpu, cpu, or auto.',
      },
    },
    node: {
      type: 'exec',
      command: [
        'set -euo pipefail',
        'export MATOS_QE_PROFILE="{{ parameters.qe_profile }}"',
        '/opt/matos-tools/qe/bin/pw.x -in "{{ parameters.qe_input_file }}" > "{{ parameters.qe_output_file }}" 2>&1',
        'grep -q "JOB DONE" "{{ parameters.qe_output_file }}"',
      ].join('\n'),
      timeoutSeconds: 7200,
      detectKnownProcessFailures: true,
    },
    usage:
      'Set qe_input_file/qe_output_file and the real timeoutSeconds budget. Keep the wrapper path, profile export, and JOB DONE grep. For claim-scale runs prefer subworkflow-call to workflow:qe-calculation-evidence, which adds preflight, budget policy, provenance, and retry diagnosis.',
  },
  {
    id: 'qe-convergence-guard',
    title: 'QE output convergence guard',
    nodeType: 'guard',
    description:
      'Gate on a QE log: JOB DONE present, no fatal/convergence-failure markers, non-empty output — with repair hints.',
    tags: ['materials', 'qe', 'dft', 'guard', 'validate'],
    parameters: {
      qe_output_file: {
        type: 'string',
        default: 'pw.out',
        description: 'QE output log to validate.',
      },
    },
    node: {
      type: 'guard',
      checks: [
        {
          type: 'file_size',
          path: '{{ parameters.qe_output_file }}',
          minBytes: 200,
          failureCode: 'qe_output_missing_or_empty',
          repairHint: 'pw.x produced no meaningful output — check the input file path and executable.',
        },
        {
          type: 'grep',
          path: '{{ parameters.qe_output_file }}',
          pattern: 'JOB DONE',
          failureCode: 'qe_not_finished',
          repairHint: 'The calculation did not reach JOB DONE — likely killed, timed out, or crashed mid-run.',
        },
        {
          type: 'regex',
          path: '{{ parameters.qe_output_file }}',
          pattern: '(convergence NOT achieved|Error in routine|MPI_ABORT|CUDA out of memory)',
          negate: true,
          failureCode: 'qe_failed_or_unconverged',
          repairHint: 'Fix convergence settings (mixing_beta, ecut, k-points) or resources before retrying; do not accept partial SCF output.',
        },
      ],
    },
    usage:
      'Point qe_output_file at the pw.x log (match qe-pw-exec). Extend the negative regex with claim-specific failure markers; add numeric_range checks on parsed values for scientific gates.',
  },
  {
    id: 'vasp-exec',
    title: 'VASP run through the MatOS wrapper',
    nodeType: 'exec',
    description:
      'vasp_std invocation through the MatOS wrapper (never the .real binaries): calculation-directory cwd, profile selection, output capture, and a timing-block completion check.',
    tags: ['materials', 'vasp', 'dft', 'exec'],
    parameters: {
      vasp_dir: {
        type: 'string',
        required: true,
        description:
          'Workspace-relative calculation directory containing INCAR, POSCAR, POTCAR, and KPOINTS.',
      },
      vasp_output_file: {
        type: 'string',
        default: 'vasp.out',
        description: 'Stdout log written inside vasp_dir; guards read OUTCAR alongside it.',
      },
      vasp_profile: {
        type: 'string',
        default: 'default',
        description:
          'MATOS_VASP_PROFILE value: default, or vasp-hdf5-w90 for HDF5/Wannier90 builds (preflight the profile first).',
      },
    },
    node: {
      type: 'exec',
      command: [
        'set -euo pipefail',
        'cd "{{ parameters.vasp_dir }}"',
        'export MATOS_VASP_PROFILE="{{ parameters.vasp_profile }}"',
        'vasp_std > "{{ parameters.vasp_output_file }}" 2>&1',
        'grep -q "General timing and accounting informations" OUTCAR',
      ].join('\n'),
      timeoutSeconds: 14400,
      detectKnownProcessFailures: true,
    },
    usage:
      'Set vasp_dir to the prepared calculation directory and timeoutSeconds to the real budget. Keep the wrapper invocation (plain vasp_std on PATH — never /opt/matos-tools/vasp/bin/.real/*), the profile export, and the OUTCAR timing grep (absent when VASP dies mid-run). Run local_toolchain_preflight before expensive runs; pair with vasp-outcar-guard for convergence gating.',
  },
  {
    id: 'vasp-outcar-guard',
    title: 'VASP OUTCAR quality guard',
    nodeType: 'guard',
    description:
      'Gate on a finished VASP run: OUTCAR carries the final timing block, no fatal-error markers, and (for relaxations) the required-accuracy line.',
    tags: ['materials', 'vasp', 'dft', 'guard', 'validate'],
    parameters: {
      vasp_dir: {
        type: 'string',
        required: true,
        description: 'Calculation directory whose OUTCAR is validated (match vasp-exec).',
      },
    },
    node: {
      type: 'guard',
      checks: [
        {
          type: 'file_size',
          path: '{{ parameters.vasp_dir }}/OUTCAR',
          minBytes: 1000,
          failureCode: 'outcar_missing_or_truncated',
          repairHint: 'OUTCAR is missing or tiny — VASP likely failed to start; check the stdout log and POTCAR/INCAR setup.',
        },
        {
          type: 'grep',
          path: '{{ parameters.vasp_dir }}/OUTCAR',
          pattern: 'General timing and accounting informations',
          failureCode: 'vasp_not_finished',
          repairHint: 'The run never reached the final timing block — killed, timed out, or crashed mid-ionic-step.',
        },
        {
          type: 'regex',
          path: '{{ parameters.vasp_dir }}/OUTCAR',
          pattern: '(I REFUSE TO CONTINUE|ZBRENT: fatal|EDDDAV: Call to ZHEGV failed|VERY BAD NEWS)',
          negate: true,
          failureCode: 'vasp_fatal_error',
          repairHint: 'A known fatal marker is present — fix the electronic/ionic settings (ALGO, POTIM, ENCUT) instead of accepting the output.',
        },
      ],
    },
    usage:
      'Set vasp_dir to match vasp-exec. For relaxations add a grep check for "reached required accuracy"; for MD/static runs keep the three defaults. Extend the fatal-marker regex with case-specific failures rather than deleting it.',
  },
  {
    id: 'lammps-exec',
    title: 'LAMMPS run',
    nodeType: 'exec',
    description:
      'lmp invocation from the mounted toolchain: explicit input and log paths plus a wall-time completion check.',
    tags: ['materials', 'lammps', 'md', 'exec'],
    parameters: {
      lammps_input_file: {
        type: 'string',
        required: true,
        description: 'Workspace-relative LAMMPS input script (e.g. in.melt).',
      },
      lammps_log_file: {
        type: 'string',
        default: 'log.lammps',
        description: 'Log path the run writes and downstream guards read.',
      },
    },
    node: {
      type: 'exec',
      command: [
        'set -euo pipefail',
        '/opt/matos-tools/lammps/bin/lmp -in "{{ parameters.lammps_input_file }}" -log "{{ parameters.lammps_log_file }}"',
        'grep -q "Total wall time" "{{ parameters.lammps_log_file }}"',
      ].join('\n'),
      timeoutSeconds: 7200,
      detectKnownProcessFailures: true,
    },
    usage:
      'Set lammps_input_file/lammps_log_file and the real timeoutSeconds. Keep the toolchain lmp path and the Total wall time grep (absent when LAMMPS aborts). Write dumps/restarts to paths your downstream nodes declare; pair with lammps-log-guard.',
  },
  {
    id: 'lammps-log-guard',
    title: 'LAMMPS log quality guard',
    nodeType: 'guard',
    description:
      'Gate on a LAMMPS log: run completed to Total wall time, and no ERROR/Lost atoms/dangerous-build markers.',
    tags: ['materials', 'lammps', 'md', 'guard', 'validate'],
    parameters: {
      lammps_log_file: {
        type: 'string',
        default: 'log.lammps',
        description: 'LAMMPS log to validate (match lammps-exec).',
      },
    },
    node: {
      type: 'guard',
      checks: [
        {
          type: 'file_size',
          path: '{{ parameters.lammps_log_file }}',
          minBytes: 200,
          failureCode: 'lammps_log_missing_or_empty',
          repairHint: 'The log is missing or trivially small — LAMMPS likely failed at startup; check the input path and packages.',
        },
        {
          type: 'grep',
          path: '{{ parameters.lammps_log_file }}',
          pattern: 'Total wall time',
          failureCode: 'lammps_not_finished',
          repairHint: 'No Total wall time line — the run was killed, timed out, or crashed before completing.',
        },
        {
          type: 'regex',
          path: '{{ parameters.lammps_log_file }}',
          pattern: '(^ERROR|Lost atoms|Dangerous builds exceeded)',
          negate: true,
          failureCode: 'lammps_run_failed',
          repairHint: 'A failure marker is present — fix the timestep, neighbor settings, or potential setup instead of accepting the trajectory.',
        },
      ],
    },
    usage:
      'Point lammps_log_file at the lammps-exec log. Add numeric_range checks on parsed thermodynamic outputs for scientific gates; extend the failure regex per force field rather than removing it.',
  },
  {
    id: 'mlip-python-exec',
    title: 'MLIP Python script step',
    nodeType: 'exec',
    description:
      'Run an MLIP/ASE/pymatgen Python script with the model-matched toolchain interpreter instead of a bare python from PATH.',
    tags: ['materials', 'mlip', 'ml', 'exec'],
    parameters: {
      mlip_interpreter: {
        type: 'string',
        default: '/opt/matos-tools/conda/envs/matos-compute/bin/python',
        description:
          'Toolchain interpreter matched to the model family: matos-compute for MACE/ASE/pymatgen, matos-mlip-py311 for CHGNet/SevenNet, matos-mlip-gnn-py311 for MatGL/M3GNet/NequIP (discover with conda_environment_catalog).',
      },
      mlip_script_file: {
        type: 'string',
        required: true,
        description: 'Workspace-relative Python script to execute.',
      },
    },
    node: {
      type: 'exec',
      command: [
        'set -euo pipefail',
        'results_dir="${MATOS_WORKFLOW_ARTIFACT_ROOT:?}"',
        '"{{ parameters.mlip_interpreter }}" "{{ parameters.mlip_script_file }}" "$results_dir"',
      ].join('\n'),
      timeoutSeconds: 7200,
      detectKnownProcessFailures: true,
    },
    usage:
      'Pick mlip_interpreter from the conda_environment_catalog table for your model family — mixing families in one env is the top MLIP failure mode. Write the script to accept the artifact root as argv[1] and save results there; gate with results-guard. For GPU work, preflight with local_toolchain_preflight checks=["gpu"] and set CUDA_VISIBLE_DEVICES in the command.',
  },
  {
    id: 'qe-evidence-subworkflow',
    title: 'QE evidence pipeline call',
    nodeType: 'subworkflow',
    description:
      'Delegate a QE calculation to the published qe-calculation-evidence workflow: preflight, budget policy, convergence/fatal checks, provenance, and retry diagnosis included.',
    tags: ['materials', 'qe', 'dft', 'subworkflow', 'reuse'],
    parameters: {
      qe_input_file: {
        type: 'string',
        required: true,
        description: 'QE input file passed to the evidence pipeline.',
      },
    },
    node: {
      type: 'subworkflow',
      workflow: 'workflow:qe-calculation-evidence',
      parameters: {
        inputFile: '{{ parameters.qe_input_file }}',
      },
    },
    usage:
      'Set qe_input_file; add the pipeline parameters you need (executable, qeProfile, timeoutSeconds, budgetPolicy — inspect them with workflow_query action=show ref=workflow:qe-calculation-evidence). This is the preferred path for claim-scale QE work: the child already validates inputs and preserves evidence.',
  },
]

const TEMPLATES_BY_ID = new Map(TEMPLATES.map(template => [template.id, template]))

export function listWorkflowNodeTemplates(filter?: {
  tag?: string
  nodeType?: string
}): MatOSWorkflowNodeTemplate[] {
  return TEMPLATES.filter(template => {
    if (filter?.tag && !template.tags.includes(filter.tag)) {
      return false
    }
    if (filter?.nodeType && template.nodeType !== filter.nodeType) {
      return false
    }
    return true
  })
}

export function workflowNodeTemplateById(
  id: string,
): MatOSWorkflowNodeTemplate | undefined {
  return TEMPLATES_BY_ID.get(id)
}

export type InstantiatedWorkflowNodeTemplate = {
  node: MatOSWorkflowNode
  parameters: Record<string, MatOSWorkflowParameter>
}

/**
 * Materialize a template into a concrete node plus the parameter specs it
 * references. Callers merge `parameters` into the definition's parameter map
 * so the node's `{{ parameters.* }}` references resolve.
 */
export function instantiateWorkflowNodeTemplate(
  template: MatOSWorkflowNodeTemplate,
  input: { id: string; dependsOn?: string[] },
): InstantiatedWorkflowNodeTemplate {
  const node = {
    ...structuredClone(template.node),
    id: input.id,
    dependsOn: input.dependsOn ?? [],
  } as MatOSWorkflowNode
  return {
    node,
    parameters: structuredClone(template.parameters),
  }
}

/**
 * Minimal single-template workflow used by the quality gate (and handy for
 * node-level smoke runs): the template node plus its parameters.
 */
export function workflowDefinitionFromTemplate(
  template: MatOSWorkflowNodeTemplate,
  input: { name?: string } = {},
): MatOSWorkflowDefinition {
  const instantiated = instantiateWorkflowNodeTemplate(template, {
    id: `${template.nodeType}_1`,
  })
  return {
    schemaVersion: 1,
    name: input.name ?? `template-${template.id}`,
    version: '0.1.0',
    parameters: instantiated.parameters,
    policy: { approvalMode: 'bypass', defaultRisk: 'low' },
    nodes: [instantiated.node],
    outputs: {},
  } as MatOSWorkflowDefinition
}

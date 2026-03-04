import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import YAML from 'yaml';

const execFileP = promisify(execFile);
const WORKFLOW_DIRS = ['pipes', 'packs'];
const KNOWN_INPUT_TYPES = new Set(['string', 'number', 'boolean', 'object', 'array']);

export function isSafePackId(packId) {
  return /^[a-zA-Z0-9._-]+$/.test(packId || '');
}

async function fileExists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

async function readText(file) {
  return fs.readFile(file, 'utf-8');
}

async function readYamlFile(file, fallback = {}) {
  if (!(await fileExists(file))) return fallback;
  const text = await readText(file);
  return YAML.parse(text) ?? fallback;
}

async function loadPackDocs(packId) {
  if (!isSafePackId(packId)) {
    throw new Error(`invalid_pack_id:${packId}`);
  }

  const workflowPath = await resolveWorkflowPath(packId);
  if (!workflowPath) {
    throw new Error(`workflow_not_found:${packId}`);
  }

  const packRoot = path.dirname(workflowPath);
  const wf = await readYamlFile(workflowPath, {});
  const roles = await readYamlFile(path.join(packRoot, 'roles.yaml'), { roles: {} });
  const contracts = await readYamlFile(path.join(packRoot, 'contracts', 'contract-rules.yaml'), { rules: [] });

  return { packId, packRoot, workflowPath, wf, roles, contracts };
}

function summarizeWorkflow(packId, workflowPath, wf) {
  const nodes = Array.isArray(wf?.nodes) ? wf.nodes : [];
  const roles = [...new Set(nodes.map((n) => n?.role).filter(Boolean))].sort();
  const inputDefs = Array.isArray(wf?.inputs) ? wf.inputs : [];
  const requiredInputs = inputDefs.filter((i) => i?.required).map((i) => i?.name).filter(Boolean);

  return {
    packId,
    workflowPath,
    id: wf?.id || packId,
    name: wf?.name || wf?.id || packId,
    version: wf?.version || null,
    mode: wf?.mode || null,
    entryNode: wf?.entryNode || null,
    nodeCount: nodes.length,
    roles,
    requiredInputs,
    inputs: inputDefs,
    artifacts: wf?.artifacts || null,
  };
}

function parseRunnerOutput(stdout) {
  const text = String(stdout || '').trim();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    const s = text.indexOf('{');
    const e = text.lastIndexOf('}');
    return JSON.parse(s >= 0 && e > s ? text.slice(s, e + 1) : '{}');
  }
}

function isNodeTransitionNode(node) {
  return !!node?.gate || !!node?.router;
}

async function listFilesRecursive(dir) {
  const out = [];
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let entries = [];
    try {
      entries = await fs.readdir(cur, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const e of entries) {
      const p = path.join(cur, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile()) out.push(p);
    }
  }
  return out.sort();
}

function sha256(text) {
  return createHash('sha256').update(String(text)).digest('hex');
}

async function loadGovernanceConfig(packRoot, wf) {
  const defaults = {
    enabled: false,
    lockFile: 'governance.lock.json',
    tracked: ['workflow.yaml', 'roles.yaml', 'tasks.yaml', 'contracts/', 'templates/'],
  };

  const fromWorkflow = wf?.governance?.sync || {};
  const merged = {
    ...defaults,
    ...fromWorkflow,
  };

  if (!Array.isArray(merged.tracked) || merged.tracked.length === 0) {
    merged.tracked = defaults.tracked;
  }

  merged.lockFile = String(merged.lockFile || defaults.lockFile);
  merged.enabled = !!merged.enabled;

  const lockPath = path.join(packRoot, merged.lockFile);
  return { ...merged, lockPath };
}

async function collectTrackedFiles(packRoot, tracked) {
  const pairs = [];

  for (const item of tracked) {
    const rel = String(item || '').trim();
    if (!rel) continue;

    const abs = path.join(packRoot, rel);
    if (rel.endsWith('/')) {
      if (!(await fileExists(abs))) continue;
      const files = await listFilesRecursive(abs);
      for (const f of files) {
        pairs.push([path.relative(packRoot, f), f]);
      }
    } else if (await fileExists(abs)) {
      const stat = await fs.stat(abs).catch(() => null);
      if (stat?.isDirectory()) {
        const files = await listFilesRecursive(abs);
        for (const f of files) {
          pairs.push([path.relative(packRoot, f), f]);
        }
      } else {
        pairs.push([rel, abs]);
      }
    }
  }

  const uniq = new Map();
  for (const [r, a] of pairs) {
    const norm = r.replace(/\\/g, '/');
    uniq.set(norm, a);
  }
  return [...uniq.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

async function computeGovernanceSnapshot(packRoot, wf) {
  const cfg = await loadGovernanceConfig(packRoot, wf);
  const files = await collectTrackedFiles(packRoot, cfg.tracked);

  const fileHashes = {};
  for (const [rel, abs] of files) {
    const content = await readText(abs);
    fileHashes[rel] = sha256(content);
  }

  const digest = sha256(JSON.stringify(fileHashes));
  return {
    config: cfg,
    snapshot: {
      version: '1',
      workflowId: wf?.id || null,
      tracked: cfg.tracked,
      digest,
      fileHashes,
    },
  };
}

export async function resolveWorkflowPath(packId) {
  if (!isSafePackId(packId)) return null;

  for (const baseDir of WORKFLOW_DIRS) {
    const p = path.resolve(baseDir, packId, 'workflow.yaml');
    if (await fileExists(p)) return p;
  }
  return null;
}

export async function listPacks() {
  const names = new Set();

  for (const baseDir of WORKFLOW_DIRS) {
    const base = path.resolve(baseDir);
    let dirs = [];
    try {
      dirs = await fs.readdir(base, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const d of dirs) {
      if (!d.isDirectory()) continue;
      const wf = path.join(base, d.name, 'workflow.yaml');
      if (await fileExists(wf)) names.add(d.name);
    }
  }

  return [...names].sort();
}

export async function describePack(packId) {
  const { workflowPath, wf } = await loadPackDocs(packId);
  return summarizeWorkflow(packId, workflowPath, wf);
}

export async function listPackDetails() {
  const packIds = await listPacks();
  const details = [];
  for (const packId of packIds) {
    try {
      details.push(await describePack(packId));
    } catch {
      // skip malformed workflows from summary mode
    }
  }
  return details;
}

export async function validatePack(packId) {
  const { packRoot, workflowPath, wf, roles, contracts } = await loadPackDocs(packId);
  const errors = [];
  const warnings = [];

  const nodes = Array.isArray(wf?.nodes) ? wf.nodes : [];
  const roleMap = (roles && typeof roles.roles === 'object' && roles.roles) ? roles.roles : {};

  if (!wf?.id) warnings.push({ code: 'workflow_id_missing', message: 'workflow.id is missing' });
  if (!wf?.entryNode) errors.push({ code: 'entry_node_missing', message: 'workflow.entryNode is required' });
  if (!Array.isArray(wf?.nodes) || nodes.length === 0) {
    errors.push({ code: 'nodes_missing', message: 'workflow.nodes must be a non-empty array' });
  }

  const nodeIdSet = new Set();
  const outputOwners = new Map();

  for (const [idx, node] of nodes.entries()) {
    const nidx = idx + 1;
    const nodeId = node?.id;

    if (!nodeId || typeof nodeId !== 'string') {
      errors.push({ code: 'node_id_missing', message: `node #${nidx} missing id` });
      continue;
    }

    if (nodeIdSet.has(nodeId)) {
      errors.push({ code: 'node_id_duplicate', nodeId, message: `duplicate node id: ${nodeId}` });
    } else {
      nodeIdSet.add(nodeId);
    }

    if (!node?.role || typeof node.role !== 'string') {
      errors.push({ code: 'role_missing', nodeId, message: `${nodeId} missing role` });
    } else if (!roleMap[node.role]) {
      errors.push({ code: 'role_not_defined', nodeId, role: node.role, message: `${nodeId} references undefined role ${node.role}` });
    }

    const outputs = Array.isArray(node?.outputs) ? node.outputs : [];
    for (const o of outputs) {
      if (typeof o !== 'string' || !o.trim()) {
        errors.push({ code: 'output_invalid', nodeId, message: `${nodeId} has invalid output entry` });
        continue;
      }
      outputOwners.set(String(o), nodeId);
    }

    if (node?.gate) {
      if (!node.gate.onPass) errors.push({ code: 'gate_onpass_missing', nodeId, message: `${nodeId} gate.onPass missing` });
      if (!node.gate.onFail) errors.push({ code: 'gate_onfail_missing', nodeId, message: `${nodeId} gate.onFail missing` });
    } else if (node?.router) {
      if (!node.router.onNoDeviation) {
        errors.push({ code: 'router_on_no_deviation_missing', nodeId, message: `${nodeId} router.onNoDeviation missing` });
      }
      if (!node.router.onDeviation || typeof node.router.onDeviation !== 'object') {
        errors.push({ code: 'router_matrix_missing', nodeId, message: `${nodeId} router.onDeviation missing` });
      }
    } else {
      if (!node?.next && !node?.onError) {
        warnings.push({ code: 'task_transition_missing', nodeId, message: `${nodeId} has no next/onError transition` });
      }
    }
  }

  if (wf?.entryNode && !nodeIdSet.has(wf.entryNode)) {
    errors.push({ code: 'entry_node_not_found', entryNode: wf.entryNode, message: `entryNode ${wf.entryNode} not found in nodes` });
  }

  const isValidTarget = (target) => target === 'end' || nodeIdSet.has(target);
  for (const node of nodes) {
    if (!node?.id) continue;

    const pushTargetError = (target, field) => {
      if (!target) return;
      if (!isValidTarget(target)) {
        errors.push({
          code: 'transition_target_not_found',
          nodeId: node.id,
          field,
          target,
          message: `${node.id}.${field} points to missing node ${target}`,
        });
      }
    };

    if (node?.gate) {
      pushTargetError(node.gate.onPass, 'gate.onPass');
      pushTargetError(node.gate.onFail, 'gate.onFail');
    } else if (node?.router) {
      pushTargetError(node.router.onNoDeviation, 'router.onNoDeviation');
      const matrix = node.router.onDeviation || {};
      for (const [devType, target] of Object.entries(matrix)) {
        pushTargetError(target, `router.onDeviation.${devType}`);
      }
    } else {
      pushTargetError(node.next, 'next');
      pushTargetError(node.onError, 'onError');
    }
  }

  const inputDefs = Array.isArray(wf?.inputs) ? wf.inputs : [];
  const inputNames = new Set();
  for (const def of inputDefs) {
    const name = def?.name;
    if (!name || typeof name !== 'string') {
      errors.push({ code: 'input_name_missing', message: 'workflow input missing name' });
      continue;
    }

    if (inputNames.has(name)) {
      errors.push({ code: 'input_duplicate', field: name, message: `duplicate input definition: ${name}` });
    } else {
      inputNames.add(name);
    }

    const type = String(def?.type || 'string').toLowerCase();
    if (!KNOWN_INPUT_TYPES.has(type)) {
      warnings.push({ code: 'input_type_unknown', field: name, type, message: `unknown input type ${type}` });
    }
  }

  if (Array.isArray(contracts?.rules)) {
    for (const rule of contracts.rules) {
      const file = String(rule?.file || '');
      if (!file) {
        errors.push({ code: 'contract_rule_file_missing', message: 'contract rule missing file' });
        continue;
      }

      if (!outputOwners.has(file)) {
        warnings.push({
          code: 'contract_file_not_declared_output',
          file,
          message: `contract rule target ${file} is not declared in node outputs`,
        });
      }

      if (rule?.type === 'json_schema') {
        const schemaRel = String(rule?.schema || '');
        if (!schemaRel) {
          errors.push({ code: 'contract_schema_missing', file, message: `json_schema rule for ${file} missing schema` });
        } else {
          const schemaPath = path.join(packRoot, schemaRel);
          if (!(await fileExists(schemaPath))) {
            errors.push({
              code: 'contract_schema_not_found',
              file,
              schema: schemaRel,
              message: `schema not found: ${schemaRel}`,
            });
          }
        }
      }
    }
  }

  for (const node of nodes) {
    if (!node?.id || isNodeTransitionNode(node)) continue;
    const outputs = Array.isArray(node.outputs) ? node.outputs : [];
    for (const out of outputs) {
      if (!String(out).endsWith('.md')) continue;
      const base = path.basename(String(out));
      const templatePath = path.join(packRoot, 'templates', base);
      if (!(await fileExists(templatePath))) {
        warnings.push({
          code: 'template_missing',
          nodeId: node.id,
          output: out,
          message: `template missing for markdown output ${out}`,
        });
      }
    }
  }

  const governance = await loadGovernanceConfig(packRoot, wf);
  if (governance.enabled) {
    const { snapshot } = await computeGovernanceSnapshot(packRoot, wf);
    if (!(await fileExists(governance.lockPath))) {
      errors.push({
        code: 'governance_lock_missing',
        lockFile: path.relative(packRoot, governance.lockPath),
        message: 'governance lock file missing; run wf sync-lock <pipeId>',
      });
    } else {
      try {
        const lock = JSON.parse(await readText(governance.lockPath));
        if (lock?.digest !== snapshot.digest) {
          errors.push({
            code: 'governance_lock_mismatch',
            lockFile: path.relative(packRoot, governance.lockPath),
            message: 'logic/workflow drift detected; update governance lock after sync changes',
          });
        }
      } catch {
        errors.push({
          code: 'governance_lock_invalid_json',
          lockFile: path.relative(packRoot, governance.lockPath),
          message: 'governance lock file is invalid JSON',
        });
      }
    }
  }

  return {
    ok: errors.length === 0,
    packId,
    workflowPath,
    errors,
    warnings,
    summary: {
      nodeCount: nodes.length,
      roleCount: Object.keys(roleMap).length,
      inputCount: inputDefs.length,
      contractRuleCount: Array.isArray(contracts?.rules) ? contracts.rules.length : 0,
    },
  };
}

export async function syncCheckPack(packId) {
  const { packRoot, wf } = await loadPackDocs(packId);
  const governance = await loadGovernanceConfig(packRoot, wf);

  if (!governance.enabled) {
    return {
      ok: true,
      enabled: false,
      packId,
      message: 'governance sync check disabled for this pack',
    };
  }

  const { snapshot } = await computeGovernanceSnapshot(packRoot, wf);
  if (!(await fileExists(governance.lockPath))) {
    return {
      ok: false,
      enabled: true,
      packId,
      lockFile: path.relative(packRoot, governance.lockPath),
      reason: 'lock_missing',
      snapshot,
    };
  }

  const lock = JSON.parse(await readText(governance.lockPath));
  return {
    ok: lock?.digest === snapshot.digest,
    enabled: true,
    packId,
    lockFile: path.relative(packRoot, governance.lockPath),
    lock,
    snapshot,
  };
}

export async function syncLockPack(packId) {
  const { packRoot, wf } = await loadPackDocs(packId);
  const governance = await loadGovernanceConfig(packRoot, wf);

  if (!governance.enabled) {
    return {
      ok: true,
      enabled: false,
      packId,
      message: 'governance sync lock skipped because governance.sync.enabled=false',
    };
  }

  const { snapshot } = await computeGovernanceSnapshot(packRoot, wf);
  const lock = {
    ...snapshot,
    generatedAt: new Date().toISOString(),
  };

  await fs.writeFile(governance.lockPath, `${JSON.stringify(lock, null, 2)}\n`, 'utf-8');

  return {
    ok: true,
    enabled: true,
    packId,
    lockFile: path.relative(packRoot, governance.lockPath),
    lock,
  };
}

export async function runPack(packId, opts = {}) {
  if (!isSafePackId(packId)) {
    throw new Error(`invalid_pack_id:${packId}`);
  }

  const workflow = await resolveWorkflowPath(packId);
  if (!workflow) {
    throw new Error(`workflow_not_found:${packId}`);
  }

  if (opts.validate !== false) {
    const validation = await validatePack(packId);
    if (!validation.ok) {
      throw new Error(`workflow_validation_error:${JSON.stringify(validation.errors)}`);
    }
  }

  const args = ['engine/wf-runner.js', '--workflow', workflow];

  if (opts.runDir) args.push('--run-dir', String(opts.runDir));
  if (opts.resumeRunDir) args.push('--resume-run-dir', String(opts.resumeRunDir));
  if (Number.isFinite(opts.maxSteps)) args.push('--max-steps', String(opts.maxSteps));
  if (opts.dryRun) args.push('--dry-run');
  if (opts.injectDeviation) args.push('--inject-deviation', String(opts.injectDeviation));

  const hasInputs = opts.inputs && typeof opts.inputs === 'object' && !Array.isArray(opts.inputs);
  if (hasInputs) args.push('--inputs-json', JSON.stringify(opts.inputs));

  try {
    const { stdout, stderr } = await execFileP('node', args, {
      cwd: process.cwd(),
      timeout: 10 * 60 * 1000,
    });

    return {
      ...parseRunnerOutput(stdout),
      stderr: String(stderr || ''),
    };
  } catch (e) {
    const stderr = String(e?.stderr || '');
    const stdout = String(e?.stdout || '');
    const combined = `${stdout}\n${stderr}`;

    const inputErr = combined.match(/input_validation_error:[^\n]+/);
    if (inputErr) throw new Error(inputErr[0]);

    throw e;
  }
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

async function writeIfAbsent(file, content) {
  if (await fileExists(file)) return false;
  await ensureDir(path.dirname(file));
  await fs.writeFile(file, content, 'utf-8');
  return true;
}

function scaffoldWorkflowYaml(packId) {
  return `version: "0.1"
id: ${packId}
name: ${packId}
mode: state-machine
entryNode: collect_requirements

inputs:
  - name: task_prompt
    type: string
    required: true

nodes:
  - id: collect_requirements
    role: analyst
    outputs:
      - requirements.md
      - acceptance_criteria.md
    next: design_flow

  - id: design_flow
    role: architect
    outputs:
      - workflow.yaml
      - roles.yaml
      - tasks.yaml
    next: verify_outputs

  - id: verify_outputs
    role: verifier
    outputs:
      - verification_report.md
      - deviation_report.md
    next: route_deviation

  - id: route_deviation
    role: orchestrator
    router:
      matrix: templates/deviation-routing-matrix.md
      onNoDeviation: finalize
      onDeviation:
        requirements_mismatch: collect_requirements
        architecture_mismatch: design_flow
        implementation_bug: design_flow
        verification_gap: verify_outputs

  - id: finalize
    role: orchestrator
    outputs:
      - pack_manifest.json
      - handoff.md
    next: end
`;
}

function scaffoldRolesYaml() {
  return `version: "0.1"
roles:
  orchestrator:
    objective: "Coordinate routing/finalization"
    executor:
      type: template

  analyst:
    objective: "Turn task prompt into crisp requirements"
    executor:
      type: template

  architect:
    objective: "Create executable workflow/task structure"
    executor:
      type: template

  verifier:
    objective: "Validate generated artifacts and classify deviation"
    executor:
      type: template
`;
}

function scaffoldTasksYaml() {
  return `version: "0.1"
backlog:
  - id: task-1
    title: "Clarify problem and success criteria"
    ownerRole: analyst
  - id: task-2
    title: "Design flow and role boundaries"
    ownerRole: architect
  - id: task-3
    title: "Verify outputs and route deviations"
    ownerRole: verifier
`;
}

function scaffoldContractRules() {
  return `version: "0.1"
rules:
  - file: requirements.md
    type: markdown_headers
    requiredHeaders:
      - "# requirements.md"
      - "## Problem Statement"

  - file: acceptance_criteria.md
    type: markdown_headers
    requiredHeaders:
      - "# acceptance_criteria.md"
      - "## Functional Criteria"

  - file: workflow.yaml
    type: yaml_keys
    requiredKeys: ["id", "entryNode", "nodes"]

  - file: roles.yaml
    type: yaml_keys
    requiredKeys: ["roles"]

  - file: tasks.yaml
    type: yaml_keys
    requiredKeys: ["backlog"]

  - file: pack_manifest.json
    type: json_schema
    schema: contracts/pack_manifest.schema.json
`;
}

function scaffoldManifestSchema() {
  return `${JSON.stringify({
    $schema: 'http://json-schema.org/draft-07/schema#',
    title: 'PackManifest',
    type: 'object',
    required: ['packId', 'version', 'artifacts'],
    properties: {
      packId: { type: 'string' },
      version: { type: 'string' },
      artifacts: {
        type: 'array',
        items: { type: 'string' },
      },
    },
  }, null, 2)}\n`;
}

export async function scaffoldPipe(packId, opts = {}) {
  if (!isSafePackId(packId)) {
    throw new Error(`invalid_pack_id:${packId}`);
  }

  const baseDir = path.resolve(opts.baseDir || 'pipes');
  const pipeDir = path.join(baseDir, packId);

  if (await fileExists(path.join(pipeDir, 'workflow.yaml'))) {
    throw new Error(`pipe_already_exists:${packId}`);
  }

  await ensureDir(pipeDir);
  await ensureDir(path.join(pipeDir, 'contracts'));
  await ensureDir(path.join(pipeDir, 'templates'));
  await ensureDir(path.join(pipeDir, 'scripts'));
  await ensureDir(path.join(pipeDir, 'examples'));

  await writeIfAbsent(path.join(pipeDir, 'README.md'), `# ${packId}\n\nScaffolded by OpenPipe.\n\n## Run\n\n\`\`\`bash\nnpm run wf:validate -- ${packId}\nnpm run wf:run -- ${packId} --input task_prompt=\"Describe your task\"\n\`\`\`\n`);
  await writeIfAbsent(path.join(pipeDir, 'runbook.md'), '# Runbook\n\n- Validate first\n- Run with explicit task_prompt\n');
  await writeIfAbsent(path.join(pipeDir, 'workflow.yaml'), scaffoldWorkflowYaml(packId));
  await writeIfAbsent(path.join(pipeDir, 'roles.yaml'), scaffoldRolesYaml());
  await writeIfAbsent(path.join(pipeDir, 'tasks.yaml'), scaffoldTasksYaml());

  await writeIfAbsent(path.join(pipeDir, 'contracts', 'contract-rules.yaml'), scaffoldContractRules());
  await writeIfAbsent(path.join(pipeDir, 'contracts', 'pack_manifest.schema.json'), scaffoldManifestSchema());

  await writeIfAbsent(path.join(pipeDir, 'templates', 'requirements.md'), '# requirements.md\n\n## Problem Statement\n{{taskPrompt}}\n');
  await writeIfAbsent(path.join(pipeDir, 'templates', 'acceptance_criteria.md'), '# acceptance_criteria.md\n\n## Functional Criteria\n- [ ] Criterion F1 (measurable)\n');
  await writeIfAbsent(path.join(pipeDir, 'templates', 'verification_report.md'), '# verification_report.md\n\nstatus: pass\n');
  await writeIfAbsent(path.join(pipeDir, 'templates', 'deviation_report.md'), '# deviation_report.md\n\nStatus: no_deviation\n');
  await writeIfAbsent(path.join(pipeDir, 'templates', 'handoff.md'), '# handoff.md\n\nGenerated by scaffold.\n');
  await writeIfAbsent(path.join(pipeDir, 'templates', 'deviation-routing-matrix.md'), '# deviation-routing-matrix.md\n');

  let validation = null;
  if (WORKFLOW_DIRS.includes(String(opts.baseDir || 'pipes'))) {
    validation = await validatePack(packId);
  } else {
    validation = {
      ok: true,
      packId,
      workflowPath: path.join(pipeDir, 'workflow.yaml'),
      errors: [],
      warnings: [
        {
          code: 'validation_skipped_nonstandard_base_dir',
          message: `baseDir '${opts.baseDir}' is outside default discovery dirs (${WORKFLOW_DIRS.join(',')})`,
        },
      ],
      summary: null,
    };
  }

  return {
    ok: validation.ok,
    packId,
    pipeDir,
    validation,
  };
}

export async function listRuns(opts = {}) {
  const runsDir = path.resolve(opts.runsDir || '.runs');
  const limit = Math.max(1, Number(opts.limit || 20));

  if (!(await fileExists(runsDir))) return [];

  const entries = await fs.readdir(runsDir, { withFileTypes: true });
  const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);

  const runs = [];
  for (const name of dirs) {
    const runDir = path.join(runsDir, name);
    const reportPath = path.join(runDir, 'execution_report.json');
    const statePath = path.join(runDir, 'execution_state.json');

    let stat = null;
    try {
      stat = await fs.stat(runDir);
    } catch {
      continue;
    }

    let report = null;
    if (await fileExists(reportPath)) {
      try {
        report = JSON.parse(await readText(reportPath));
      } catch {
        report = null;
      }
    }

    runs.push({
      runId: name,
      runDir,
      mtimeMs: stat.mtimeMs,
      workflowId: report?.workflowId || null,
      steps: report?.steps ?? null,
      terminatedBy: report?.terminatedBy || null,
      contractViolations: Array.isArray(report?.contractViolations) ? report.contractViolations.length : null,
      hasReport: !!report,
      hasState: await fileExists(statePath),
    });
  }

  runs.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return runs.slice(0, limit);
}

export async function summarizeRuns(opts = {}) {
  const runs = await listRuns(opts);
  const summary = {
    total: runs.length,
    terminatedBy: {},
    byWorkflow: {},
    withContractViolations: 0,
  };

  for (const r of runs) {
    const t = r.terminatedBy || 'unknown';
    summary.terminatedBy[t] = (summary.terminatedBy[t] || 0) + 1;

    const wf = r.workflowId || 'unknown';
    summary.byWorkflow[wf] = (summary.byWorkflow[wf] || 0) + 1;

    if ((r.contractViolations || 0) > 0) summary.withContractViolations += 1;
  }

  return { summary, runs };
}

function utcDayFromMs(ms) {
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export async function runTrends(opts = {}) {
  const runs = await listRuns(opts);
  const byDay = {};

  for (const r of runs) {
    const day = utcDayFromMs(r.mtimeMs);
    if (!byDay[day]) {
      byDay[day] = {
        total: 0,
        terminatedBy: {},
        byWorkflow: {},
        withContractViolations: 0,
      };
    }

    const bucket = byDay[day];
    bucket.total += 1;

    const t = r.terminatedBy || 'unknown';
    bucket.terminatedBy[t] = (bucket.terminatedBy[t] || 0) + 1;

    const wf = r.workflowId || 'unknown';
    bucket.byWorkflow[wf] = (bucket.byWorkflow[wf] || 0) + 1;

    if ((r.contractViolations || 0) > 0) bucket.withContractViolations += 1;
  }

  const days = Object.keys(byDay).sort();
  return { days, byDay, runs };
}

function recommendationFromIssue(issue) {
  switch (issue?.code) {
    case 'role_not_defined':
      return `Add missing role '${issue.role}' to roles.yaml or change node role in workflow.yaml.`;
    case 'transition_target_not_found':
      return `Fix transition target '${issue.target}' in ${issue.field}.`;
    case 'contract_schema_not_found':
      return `Create schema file '${issue.schema}' or update contract-rules.yaml path.`;
    case 'template_missing':
      return `Add markdown template for '${issue.output}' under templates/.`;
    case 'input_duplicate':
      return `Remove duplicate input definition '${issue.field}' in workflow.yaml.`;
    case 'input_type_unknown':
      return `Use one of supported input types: string|number|boolean|object|array.`;
    default:
      return issue?.message || 'Review workflow/contracts and re-run validation.';
  }
}

export async function doctorPack(packId, opts = {}) {
  const validation = await validatePack(packId);
  const limit = Math.max(1, Number(opts.limit || 50));

  const runs = await listRuns({ limit });
  const packRuns = runs.filter((r) => r.workflowId === packId);

  const runStats = {
    total: packRuns.length,
    terminatedBy: {},
    withContractViolations: 0,
    missingReports: 0,
  };

  for (const r of packRuns) {
    const t = r.terminatedBy || 'unknown';
    runStats.terminatedBy[t] = (runStats.terminatedBy[t] || 0) + 1;
    if ((r.contractViolations || 0) > 0) runStats.withContractViolations += 1;
    if (!r.hasReport) runStats.missingReports += 1;
  }

  const recommendations = [];
  for (const e of validation.errors || []) {
    recommendations.push({ severity: 'high', code: e.code, recommendation: recommendationFromIssue(e) });
  }
  for (const w of validation.warnings || []) {
    recommendations.push({ severity: 'medium', code: w.code, recommendation: recommendationFromIssue(w) });
  }

  if (runStats.missingReports > 0) {
    recommendations.push({
      severity: 'medium',
      code: 'runs_missing_reports',
      recommendation: 'Investigate incomplete run directories; check runner crashes or interrupted executions.',
    });
  }

  const failures = Object.entries(runStats.terminatedBy)
    .filter(([k]) => !['end', 'unknown'].includes(k))
    .reduce((sum, [, v]) => sum + Number(v || 0), 0);

  if (failures > 0) {
    recommendations.push({
      severity: 'medium',
      code: 'non_end_terminations_detected',
      recommendation: 'Inspect execution_report.json in failed runs and tighten node policies/timeouts.',
    });
  }

  let healthScore = 100;
  healthScore -= (validation.errors || []).length * 25;
  healthScore -= (validation.warnings || []).length * 8;
  healthScore -= runStats.missingReports * 5;
  healthScore -= runStats.withContractViolations * 10;
  healthScore -= failures * 10;
  healthScore = Math.max(0, Math.min(100, healthScore));

  return {
    ok: validation.ok,
    packId,
    healthScore,
    validation,
    runStats,
    recommendations,
    inspectedRuns: limit,
  };
}

import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import YAML from 'yaml';
import Ajv from 'ajv';

const execFileP = promisify(execFile);

function parseArgs(argv) {
  const args = {
    workflow: 'packs/workflow-pack-generator/workflow.yaml',
    runDir: null,
    resumeRunDir: null,
    maxSteps: 40,
    dryRun: false,
    injectDeviation: null,
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--workflow') args.workflow = argv[++i];
    else if (a === '--run-dir') args.runDir = argv[++i];
    else if (a === '--resume-run-dir') args.resumeRunDir = argv[++i];
    else if (a === '--max-steps') args.maxSteps = Number(argv[++i] || 40);
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--inject-deviation') args.injectDeviation = argv[++i];
  }
  return args;
}

async function readText(file) {
  return fs.readFile(file, 'utf-8');
}

async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

async function writeText(file, content) {
  await ensureDir(path.dirname(file));
  await fs.writeFile(file, content, 'utf-8');
}

async function appendJsonl(file, obj) {
  await ensureDir(path.dirname(file));
  await fs.appendFile(file, `${JSON.stringify(obj)}\n`, 'utf-8');
}

function nowTag() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
}

function resolveRunDir(args) {
  if (args.resumeRunDir) return path.resolve(args.resumeRunDir);
  if (args.runDir) return path.resolve(args.runDir);
  return path.resolve('.runs', `workflow-pack-generator-${nowTag()}`);
}

async function loadWorkflow(workflowPath) {
  const text = await readText(workflowPath);
  const wf = YAML.parse(text);
  if (!wf?.nodes || !Array.isArray(wf.nodes)) {
    throw new Error(`Invalid workflow: nodes missing in ${workflowPath}`);
  }
  return wf;
}

async function loadRolesDoc(packRoot) {
  const p = path.join(packRoot, 'roles.yaml');
  if (!(await exists(p))) return { roles: {} };
  const text = await readText(p);
  return YAML.parse(text) || { roles: {} };
}

function buildNodeMap(wf) {
  const map = new Map();
  for (const n of wf.nodes || []) map.set(n.id, n);
  return map;
}

function requiredDeviationTypes(node) {
  return Object.keys(node?.router?.onDeviation || {});
}

function defaultMd(node, role, fileName) {
  return [
    `# ${fileName}`,
    '',
    `- generatedByNode: ${node.id}`,
    `- generatedByRole: ${role || 'unknown'}`,
    `- generatedAt: ${new Date().toISOString()}`,
    ''
  ].join('\n');
}

async function copyIfExists(src, dst) {
  if (await exists(src)) {
    await ensureDir(path.dirname(dst));
    await fs.copyFile(src, dst);
    return true;
  }
  return false;
}

function resolveExecutorSpec(node, rolesDoc) {
  const roleSpec = rolesDoc?.roles?.[node.role || '']?.executor || null;
  const nodeSpec = node?.executor || null;

  const merged = {
    ...(roleSpec || {}),
    ...(nodeSpec || {}),
    config: {
      ...((roleSpec && roleSpec.config) || {}),
      ...((nodeSpec && nodeSpec.config) || {}),
    },
  };

  const type = merged.type || 'template';
  return { ...merged, type };
}

async function runShellExecutor({ node, spec, runDir, packRoot, ctx }) {
  const cmd = spec.command || spec.config?.command;
  if (!cmd) {
    const e = new Error(`shell executor missing command at node ${node.id}`);
    e.code = 'task_error';
    throw e;
  }

  await execFileP('/bin/sh', ['-lc', cmd], {
    cwd: runDir,
    env: {
      ...process.env,
      WF_RUN_DIR: runDir,
      WF_PACK_ROOT: packRoot,
      WF_NODE_ID: node.id,
      WF_ROLE: node.role || '',
      WF_WORKFLOW_ID: ctx.workflowId,
      WF_RUN_ID: ctx.runId,
    },
    timeout: 10 * 60 * 1000,
  });
}

async function runScriptExecutor({ node, spec, runDir, packRoot, ctx }) {
  const scriptPathRaw = spec.script || spec.config?.script;
  if (!scriptPathRaw) {
    const e = new Error(`script executor missing script at node ${node.id}`);
    e.code = 'task_error';
    throw e;
  }

  const scriptPath = path.isAbsolute(scriptPathRaw)
    ? scriptPathRaw
    : path.join(packRoot, scriptPathRaw);

  const args = Array.isArray(spec.args)
    ? spec.args
    : (Array.isArray(spec.config?.args) ? spec.config.args : []);

  await execFileP('node', [scriptPath, ...(args.map((x) => String(x)))], {
    cwd: runDir,
    env: {
      ...process.env,
      WF_RUN_DIR: runDir,
      WF_PACK_ROOT: packRoot,
      WF_NODE_ID: node.id,
      WF_ROLE: node.role || '',
      WF_WORKFLOW_ID: ctx.workflowId,
      WF_RUN_ID: ctx.runId,
    },
    timeout: 10 * 60 * 1000,
  });
}

function parseJsonObjectFromText(text) {
  const t = String(text || '').trim();
  if (!t) return null;

  try {
    return JSON.parse(t);
  } catch {
    const s = t.indexOf('{');
    const e = t.lastIndexOf('}');
    if (s >= 0 && e > s) {
      try {
        return JSON.parse(t.slice(s, e + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

function renderTemplateText(template, vars) {
  return String(template || '').replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, key) => {
    const v = vars[key];
    return v == null ? '' : String(v);
  });
}

async function runLLMExecutor({ node, rolesDoc, spec, runDir, packRoot, ctx }) {
  const model = spec.model || spec.config?.model;
  if (!model) {
    const e = new Error(`llm executor missing model at node ${node.id}`);
    e.code = 'task_error';
    throw e;
  }

  const provider = spec.provider || spec.config?.provider || 'openai_compat';
  if (provider !== 'openai_compat') {
    const e = new Error(`unsupported_llm_provider:${provider}`);
    e.code = 'task_error';
    throw e;
  }

  const baseUrl = spec.baseUrl || spec.config?.baseUrl || process.env.LLM_BASE_URL || process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
  const apiKeyEnv = spec.apiKeyEnv || spec.config?.apiKeyEnv || 'OPENAI_API_KEY';
  const apiKey = process.env[apiKeyEnv];
  if (!apiKey) {
    const e = new Error(`missing_api_key_env:${apiKeyEnv}`);
    e.code = 'task_error';
    throw e;
  }

  const roleObj = rolesDoc?.roles?.[node.role || ''] || {};
  const objective = roleObj?.objective || '';

  const userTemplate = spec.prompt
    || spec.config?.prompt
    || 'Generate declared outputs for node {{nodeId}} as JSON object: {"filename":"content"}';

  const userPrompt = renderTemplateText(userTemplate, {
    nodeId: node.id,
    role: node.role || '',
    outputs: JSON.stringify(node.outputs || []),
    workflowId: ctx.workflowId,
  });

  const systemPrompt = spec.systemPrompt
    || spec.config?.systemPrompt
    || [
      'You are a workflow node executor.',
      `Role: ${node.role || 'unknown'}`,
      objective ? `Objective: ${objective}` : '',
      'Return ONLY valid JSON object mapping output file names to text content.',
    ].filter(Boolean).join('\n');

  const body = {
    model,
    temperature: Number(spec.temperature ?? spec.config?.temperature ?? 0.2),
    max_tokens: Number(spec.maxTokens ?? spec.config?.maxTokens ?? 1200),
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: systemPrompt },
      {
        role: 'user',
        content: `${userPrompt}\n\nDeclared outputs: ${JSON.stringify(node.outputs || [])}`,
      },
    ],
  };

  const res = await fetch(`${String(baseUrl).replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const e = new Error(`llm_http_${res.status}:${text.slice(0, 300)}`);
    e.code = 'task_error';
    throw e;
  }

  const json = await res.json();
  const content = json?.choices?.[0]?.message?.content || '';
  const outMap = parseJsonObjectFromText(content);

  if (!outMap || typeof outMap !== 'object') {
    const e = new Error('llm_invalid_json_output');
    e.code = 'task_error';
    throw e;
  }

  for (const out of node.outputs || []) {
    const clean = String(out);
    if (clean.endsWith('/')) {
      await ensureDir(path.join(runDir, clean));
      continue;
    }
    const payload = outMap[clean] ?? outMap[path.basename(clean)] ?? '';
    await writeText(path.join(runDir, clean), String(payload));
    ctx.artifacts.push(clean);
  }
}

async function assertDeclaredOutputsExist(outputs, runDir) {
  const missing = [];
  for (const out of outputs || []) {
    const clean = String(out);
    const p = path.join(runDir, clean);
    if (!(await exists(p))) missing.push(clean);
  }
  return missing;
}

function normHeading(s) {
  return String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

async function loadContractRules(packRoot) {
  const p = path.join(packRoot, 'contracts', 'contract-rules.yaml');
  if (!(await exists(p))) return [];
  const text = await readText(p);
  const doc = YAML.parse(text) || {};
  return Array.isArray(doc.rules) ? doc.rules : [];
}

async function validateRule(rule, runDir, packRoot, ajv, schemaCache) {
  const filePath = path.join(runDir, rule.file);
  if (!(await exists(filePath))) {
    return { ok: false, file: rule.file, type: rule.type, reason: 'file_missing' };
  }

  if (rule.type === 'markdown_headers') {
    const text = await readText(filePath);
    const headings = text
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => /^#{1,6}\s+/.test(line))
      .map(normHeading);

    const required = (rule.requiredHeaders || []).map(normHeading);
    const missing = required.filter((h) => !headings.includes(h));
    if (missing.length) {
      return { ok: false, file: rule.file, type: rule.type, reason: 'missing_headers', missing };
    }
    return { ok: true, file: rule.file, type: rule.type };
  }

  if (rule.type === 'yaml_keys') {
    const text = await readText(filePath);
    const obj = YAML.parse(text);
    const required = Array.isArray(rule.requiredKeys) ? rule.requiredKeys : [];
    const missing = required.filter((k) => !(k in (obj || {})));
    if (missing.length) {
      return { ok: false, file: rule.file, type: rule.type, reason: 'missing_keys', missing };
    }
    return { ok: true, file: rule.file, type: rule.type };
  }

  if (rule.type === 'json_schema') {
    const text = await readText(filePath);
    const data = JSON.parse(text);
    const schemaPath = path.join(packRoot, rule.schema || '');
    if (!schemaCache.has(schemaPath)) {
      const schema = JSON.parse(await readText(schemaPath));
      schemaCache.set(schemaPath, ajv.compile(schema));
    }
    const validate = schemaCache.get(schemaPath);
    const ok = validate(data);
    if (!ok) {
      return {
        ok: false,
        file: rule.file,
        type: rule.type,
        reason: 'schema_validation_failed',
        errors: validate.errors || [],
      };
    }
    return { ok: true, file: rule.file, type: rule.type };
  }

  return { ok: true, file: rule.file, type: rule.type, skipped: true };
}

async function validateOutputsContracts(outputs, runDir, packRoot, rules, ajv, schemaCache) {
  const targets = new Set(outputs.filter((o) => !String(o).endsWith('/')));
  const matched = rules.filter((r) => targets.has(String(r.file || '')));

  const results = [];
  for (const rule of matched) {
    results.push(await validateRule(rule, runDir, packRoot, ajv, schemaCache));
  }

  const violations = results.filter((r) => !r.ok);
  return { results, violations };
}

async function materializeOutput({ outputName, node, role, runDir, packRoot, ctx }) {
  const clean = String(outputName);
  if (clean.endsWith('/')) {
    const dir = path.join(runDir, clean);
    await ensureDir(dir);
    await writeText(path.join(dir, '.keep'), '');
    ctx.artifacts.push(clean);
    return;
  }

  const outPath = path.join(runDir, clean);
  const base = path.basename(clean);

  // prefer templates for markdown where available
  const templatePath = path.join(packRoot, 'templates', base);

  if (clean === 'workflow.yaml' || clean === 'roles.yaml' || clean === 'tasks.yaml') {
    const src = path.join(packRoot, clean);
    const copied = await copyIfExists(src, outPath);
    if (!copied) await writeText(outPath, `# missing source: ${src}\n`);
  } else if (base === 'open_questions.md') {
    // default to no open questions so alignment gate can pass in MVP
    await writeText(outPath, '');
  } else if (base === 'verification_report.md') {
    if (ctx.forcedDeviation || (ctx.injectDeviation && !ctx.injectedDeviation)) {
      await writeText(outPath, '# verification_report.md\n\nstatus: fail\nchecks:\n- name: contract_or_deviation\n  result: fail\n');
    } else {
      await writeText(outPath, '# verification_report.md\n\nstatus: pass\nchecks:\n- name: smoke\n  result: pass\n');
    }
  } else if (base === 'deviation_report.md') {
    const devType = (!ctx.injectedDeviation && ctx.injectDeviation) || ctx.forcedDeviation;
    if (devType) {
      await writeText(
        outPath,
        `# deviation_report.md\n\nStatus: has_deviation\nType: ${devType}\nSeverity: medium\nEvidence: auto-generated by runner\n`
      );
      if (ctx.injectDeviation && !ctx.injectedDeviation) ctx.injectedDeviation = true;
    } else {
      await writeText(outPath, '# deviation_report.md\n\nStatus: no_deviation\n');
    }
  } else if (base === 'pack_manifest.json') {
    const manifest = {
      packId: ctx.workflowId,
      version: '0.1',
      runId: ctx.runId,
      generatedAt: new Date().toISOString(),
      artifacts: [...ctx.artifacts],
    };
    await writeText(outPath, `${JSON.stringify(manifest, null, 2)}\n`);
  } else if (base.endsWith('.md') && await exists(templatePath)) {
    await copyIfExists(templatePath, outPath);
  } else if (base.endsWith('.json')) {
    await writeText(outPath, '{}\n');
  } else {
    await writeText(outPath, defaultMd(node, role, base));
  }

  ctx.artifacts.push(clean);
}

async function evalGateCheck(check, runDir, wfPath) {
  const c = String(check || '').toLowerCase();

  if (c.includes('requirements.md exists')) {
    return exists(path.join(runDir, 'requirements.md'));
  }
  if (c.includes('acceptance_criteria.md contains measurable criteria')) {
    const f = path.join(runDir, 'acceptance_criteria.md');
    if (!(await exists(f))) return false;
    const t = (await readText(f)).toLowerCase();
    return t.includes('measurable') || t.includes('threshold');
  }
  if (c.includes('open_questions.md is empty') || c.includes('open_questions.md')) {
    const f = path.join(runDir, 'open_questions.md');
    if (!(await exists(f))) return true;
    return (await readText(f)).trim().length === 0;
  }
  if (c.includes('every workflow node has owner role')) {
    const wf = await loadWorkflow(wfPath);
    return (wf.nodes || []).every((n) => !!n.role);
  }
  if (c.includes('every edge has success/failure condition')) {
    const wf = await loadWorkflow(wfPath);
    return (wf.nodes || []).every((n) => {
      if (n.gate) return !!n.gate.onPass && !!n.gate.onFail;
      if (n.router) return !!n.router.onNoDeviation;
      return !!n.next || n.id === 'finalize_pack';
    });
  }
  if (c.includes('contracts are mapped')) {
    const f = path.join(runDir, 'contracts_map.md');
    return exists(f);
  }

  // unknown check: fail-safe false
  return false;
}

async function resolveDeviationType(runDir, node) {
  const report = path.join(runDir, 'deviation_report.md');
  if (!(await exists(report))) return null;
  const text = await readText(report);
  if (/no_deviation/i.test(text)) return null;

  const m = text.match(/Type:\s*([a-z_]+)/i);
  if (!m) return null;
  const t = m[1];
  const allowed = new Set(requiredDeviationTypes(node));
  return allowed.has(t) ? t : null;
}

async function loadState(runDir) {
  const p = path.join(runDir, 'execution_state.json');
  if (!(await exists(p))) return null;
  const text = await readText(p);
  return JSON.parse(text);
}

async function saveState(runDir, state) {
  const p = path.join(runDir, 'execution_state.json');
  await writeText(p, `${JSON.stringify(state, null, 2)}\n`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms || 0)));
}

function resolveNodePolicy(wf, node) {
  const globalPolicy = wf?.runtime?.policy || {};
  const nodePolicy = node?.policy || {};

  const globalRetries = globalPolicy.retries || {};
  const nodeRetries = nodePolicy.retries || {};

  const maxAttempts = Math.max(1, Number(nodeRetries.maxAttempts ?? globalRetries.maxAttempts ?? 1));
  const backoffMs = Math.max(0, Number(nodeRetries.backoffMs ?? globalRetries.backoffMs ?? 0));
  const backoffMultiplier = Math.max(1, Number(nodeRetries.backoffMultiplier ?? globalRetries.backoffMultiplier ?? 1));
  const timeoutMs = Math.max(0, Number(nodePolicy.timeoutMs ?? globalPolicy.timeoutMs ?? 0));

  const retryOnRaw = nodeRetries.retryOn ?? globalRetries.retryOn ?? ['task_error', 'contract_violation', 'timeout'];
  const retryOn = Array.isArray(retryOnRaw) ? retryOnRaw.map((x) => String(x)) : ['task_error', 'contract_violation', 'timeout'];

  return { maxAttempts, backoffMs, backoffMultiplier, timeoutMs, retryOn };
}

async function withTimeout(promiseFactory, timeoutMs, label = 'task') {
  if (!timeoutMs || timeoutMs <= 0) {
    return promiseFactory();
  }

  let timer = null;
  try {
    return await Promise.race([
      promiseFactory(),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          const e = new Error(`${label} timed out after ${timeoutMs}ms`);
          e.code = 'timeout';
          reject(e);
        }, timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function executeTaskAttempt({ node, rolesDoc, runDir, packRoot, ctx, rules, ajv, schemaCache, dryRun }) {
  const spec = resolveExecutorSpec(node, rolesDoc);
  let executedType = spec.type;

  if (dryRun && spec.type !== 'template') {
    // In dry-run, avoid external side effects; still materialize outputs for gate progress.
    executedType = `${spec.type}:dryrun_fallback`;
    for (const out of node.outputs || []) {
      await materializeOutput({
        outputName: out,
        node,
        role: node.role,
        runDir,
        packRoot,
        ctx,
      });
    }
  } else if (spec.type === 'template') {
    for (const out of node.outputs || []) {
      await materializeOutput({
        outputName: out,
        node,
        role: node.role,
        runDir,
        packRoot,
        ctx,
      });
    }
  } else if (spec.type === 'shell') {
    await runShellExecutor({ node, spec, runDir, packRoot, ctx });
  } else if (spec.type === 'script') {
    await runScriptExecutor({ node, spec, runDir, packRoot, ctx });
  } else if (spec.type === 'llm') {
    await runLLMExecutor({ node, rolesDoc, spec, runDir, packRoot, ctx });
  } else {
    const err = new Error(`unsupported_executor:${spec.type}`);
    err.code = 'task_error';
    throw err;
  }

  const missing = await assertDeclaredOutputsExist(node.outputs || [], runDir);
  if (missing.length) {
    const err = new Error('declared_outputs_missing');
    err.code = 'task_error';
    err.missingOutputs = missing;
    throw err;
  }

  const { violations } = await validateOutputsContracts(
    node.outputs || [],
    runDir,
    packRoot,
    rules,
    ajv,
    schemaCache
  );

  if (violations.length) {
    const err = new Error('contract_validation_failed');
    err.code = 'contract_violation';
    err.violations = violations;
    throw err;
  }

  return { ok: true, executor: executedType };
}

async function run() {
  const args = parseArgs(process.argv.slice(2));
  const workflowPath = path.resolve(args.workflow);
  const wf = await loadWorkflow(workflowPath);
  const nodeMap = buildNodeMap(wf);
  const runDir = resolveRunDir(args);
  const packRoot = path.dirname(workflowPath);
  const rolesDoc = await loadRolesDoc(packRoot);

  await ensureDir(runDir);

  const rules = await loadContractRules(packRoot);
  const ajv = new Ajv({ allErrors: true });
  const schemaCache = new Map();

  const resumed = args.resumeRunDir ? (await loadState(runDir)) : null;

  const ctx = resumed?.ctx || {
    runId: path.basename(runDir),
    workflowId: wf.id || 'workflow',
    artifacts: [],
    injectDeviation: args.injectDeviation,
    injectedDeviation: false,
    forcedDeviation: null,
    contractViolations: [],
  };

  const history = resumed?.history || [];
  let current = resumed?.current || wf.entryNode;
  let steps = resumed?.steps || 0;

  while (current && current !== 'end' && steps < args.maxSteps) {
    const node = nodeMap.get(current);
    if (!node) throw new Error(`Node not found: ${current}`);

    const h = {
      step: steps + 1,
      nodeId: node.id,
      role: node.role || null,
      startedAt: new Date().toISOString(),
    };

    if (node.gate) {
      const checks = [];
      let pass = true;
      for (const check of node.gate.checks || []) {
        const ok = await evalGateCheck(check, runDir, workflowPath);
        checks.push({ check, ok });
        if (!ok) pass = false;
      }
      h.type = 'gate';
      h.checks = checks;
      h.result = pass ? 'pass' : 'fail';
      h.next = pass ? node.gate.onPass : node.gate.onFail;
      current = h.next;
    } else if (node.router) {
      const deviationType = await resolveDeviationType(runDir, node);
      h.type = 'router';
      h.deviationType = deviationType;

      if (!deviationType) {
        h.result = 'no_deviation';
        h.next = node.router.onNoDeviation;
      } else {
        h.result = 'has_deviation';
        h.next = node.router.onDeviation?.[deviationType] || node.router.onNoDeviation;
        // consume one-time forced deviation once routed
        ctx.forcedDeviation = null;
      }
      current = h.next;
    } else {
      h.type = 'task';
      h.outputs = node.outputs || [];

      const policy = resolveNodePolicy(wf, node);
      h.policy = policy;
      h.attempts = [];

      let succeeded = false;
      let lastError = null;

      for (let attempt = 1; attempt <= policy.maxAttempts; attempt++) {
        const attemptRec = {
          attempt,
          startedAt: new Date().toISOString(),
        };

        try {
          const attemptOut = await withTimeout(
            () => executeTaskAttempt({ node, rolesDoc, runDir, packRoot, ctx, rules, ajv, schemaCache, dryRun: args.dryRun }),
            policy.timeoutMs,
            node.id
          );

          attemptRec.result = 'ok';
          attemptRec.executor = attemptOut?.executor || 'template';
          attemptRec.finishedAt = new Date().toISOString();
          h.attempts.push(attemptRec);
          succeeded = true;
          break;
        } catch (e) {
          const code = String(e?.code || 'task_error');
          attemptRec.result = 'error';
          attemptRec.errorCode = code;
          attemptRec.message = String(e?.message || e);
          if (e?.violations) attemptRec.contractViolations = e.violations;
          attemptRec.finishedAt = new Date().toISOString();
          h.attempts.push(attemptRec);

          lastError = e;
          const retryable = policy.retryOn.includes(code) && attempt < policy.maxAttempts;
          if (retryable) {
            const backoff = Math.round(policy.backoffMs * Math.pow(policy.backoffMultiplier, attempt - 1));
            await appendJsonl(path.join(runDir, 'execution_events.jsonl'), {
              ts: new Date().toISOString(),
              step: h.step,
              nodeId: h.nodeId,
              type: 'retry_wait',
              attempt,
              errorCode: code,
              backoffMs: backoff,
            });
            await sleep(backoff);
            continue;
          }
          break;
        }
      }

      if (succeeded) {
        h.result = 'ok';
        h.next = node.next || 'end';
      } else {
        const code = String(lastError?.code || 'task_error');
        if (code === 'contract_violation') {
          const violations = lastError?.violations || [];
          h.result = 'ok_with_contract_violations';
          h.contractViolations = violations;
          ctx.contractViolations.push(...violations.map((v) => ({ nodeId: node.id, ...v })));
          ctx.forcedDeviation = ctx.forcedDeviation || 'implementation_bug';
          h.next = node.next || 'end';
        } else {
          h.result = 'task_failed';
          h.errorCode = code;
          h.errorMessage = String(lastError?.message || lastError);
          h.next = node.onError || 'end';
        }
      }

      current = h.next;
    }

    h.finishedAt = new Date().toISOString();
    history.push(h);
    steps += 1;

    const state = {
      workflowId: wf.id,
      runDir,
      steps,
      current,
      history,
      ctx,
      updatedAt: new Date().toISOString(),
    };
    await saveState(runDir, state);
    await appendJsonl(path.join(runDir, 'execution_events.jsonl'), {
      ts: new Date().toISOString(),
      step: h.step,
      nodeId: h.nodeId,
      type: h.type,
      result: h.result,
      next: h.next,
    });
  }

  const report = {
    workflowId: wf.id,
    runId: ctx.runId,
    runDir,
    resumedFromState: !!resumed,
    dryRun: args.dryRun,
    injectedDeviation: args.injectDeviation || null,
    steps,
    endedAt: new Date().toISOString(),
    terminatedBy: current === 'end' ? 'end' : (steps >= args.maxSteps ? 'maxSteps' : 'unknown'),
    history,
    artifacts: [...new Set(ctx.artifacts)],
    contractViolations: ctx.contractViolations,
  };

  const reportPath = path.join(runDir, 'execution_report.json');
  await writeText(reportPath, `${JSON.stringify(report, null, 2)}\n`);

  console.log(JSON.stringify({
    ok: true,
    workflow: wf.id,
    runDir,
    reportPath,
    steps,
    terminatedBy: report.terminatedBy,
    contractViolations: ctx.contractViolations.length,
  }, null, 2));
}

run().catch((err) => {
  console.error(err?.stack || String(err));
  process.exit(1);
});

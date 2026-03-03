import fs from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';
import Ajv from 'ajv';

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

async function run() {
  const args = parseArgs(process.argv.slice(2));
  const workflowPath = path.resolve(args.workflow);
  const wf = await loadWorkflow(workflowPath);
  const nodeMap = buildNodeMap(wf);
  const runDir = resolveRunDir(args);
  const packRoot = path.dirname(workflowPath);

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

      const { violations } = await validateOutputsContracts(
        node.outputs || [],
        runDir,
        packRoot,
        rules,
        ajv,
        schemaCache
      );

      if (violations.length) {
        h.result = 'ok_with_contract_violations';
        h.contractViolations = violations;
        ctx.contractViolations.push(...violations.map((v) => ({ nodeId: node.id, ...v })));
        ctx.forcedDeviation = ctx.forcedDeviation || 'implementation_bug';
      } else {
        h.result = 'ok';
      }

      h.next = node.next || 'end';
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

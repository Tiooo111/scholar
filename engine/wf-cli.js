#!/usr/bin/env node
import {
  describePack,
  doctorPack,
  listPackDetails,
  listPacks,
  listRuns,
  runPack,
  runTrends,
  scaffoldPipe,
  summarizeRuns,
  syncCheckPack,
  syncLockPack,
  validatePack,
} from './wf-core.js';

function parseMaybeJson(value) {
  if (value == null) return value;
  const raw = String(value).trim();
  if (!raw) return '';
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function parseInputKV(text) {
  const raw = String(text || '');
  const idx = raw.indexOf('=');
  if (idx <= 0) {
    return { key: raw.trim(), value: true };
  }

  const key = raw.slice(0, idx).trim();
  const value = parseMaybeJson(raw.slice(idx + 1));
  return { key, value };
}

function parseArgs(argv) {
  const out = {
    cmd: argv[0] || 'help',
    packId: null,
    runDir: null,
    resumeRunDir: null,
    maxSteps: null,
    dryRun: false,
    injectDeviation: null,
    details: false,
    inputs: {},
    inputsJson: null,
    limit: 20,
    summaryOnly: false,
    baseDir: 'pipes',
    trends: false,
  };

  let start = 1;
  if ((out.cmd === 'run' || out.cmd === 'describe' || out.cmd === 'validate' || out.cmd === 'scaffold' || out.cmd === 'doctor' || out.cmd === 'sync-check' || out.cmd === 'sync-lock') && argv[1] && !String(argv[1]).startsWith('--')) {
    out.packId = argv[1];
    start = 2;
  }

  for (let i = start; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--run-dir') out.runDir = argv[++i];
    else if (a === '--resume-run-dir') out.resumeRunDir = argv[++i];
    else if (a === '--max-steps') out.maxSteps = Number(argv[++i]);
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--inject-deviation') out.injectDeviation = argv[++i];
    else if (a === '--details') out.details = true;
    else if (a === '--limit') out.limit = Number(argv[++i]);
    else if (a === '--summary-only') out.summaryOnly = true;
    else if (a === '--trends') out.trends = true;
    else if (a === '--base-dir') out.baseDir = argv[++i] || 'pipes';
    else if (a === '--input') {
      const { key, value } = parseInputKV(argv[++i] || '');
      if (key) out.inputs[key] = value;
    } else if (a === '--inputs-json') {
      out.inputsJson = argv[++i];
    }
  }

  if (out.inputsJson) {
    const parsed = JSON.parse(out.inputsJson);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('inputs-json must be a JSON object');
    }
    out.inputs = { ...parsed, ...out.inputs };
  }

  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.cmd === 'help' || args.cmd === '--help' || args.cmd === '-h') {
    console.log(`Usage:\n  wf list [--details]\n  wf describe <pipeId>\n  wf validate <pipeId>\n  wf doctor <pipeId> [--limit 50]\n  wf sync-check <pipeId>\n  wf sync-lock <pipeId>\n  wf scaffold <pipeId> [--base-dir pipes]\n  wf runs [--limit 20] [--summary-only|--trends]\n  wf run <pipeId> [--dry-run] [--run-dir <dir>] [--resume-run-dir <dir>] [--max-steps <n>] [--inject-deviation <type>] [--input key=value] [--inputs-json '{"task_prompt":"..."}']`);
    return;
  }

  if (args.cmd === 'list') {
    if (args.details) {
      const packs = await listPackDetails();
      console.log(JSON.stringify({ ok: true, packs }, null, 2));
      return;
    }

    const packs = await listPacks();
    console.log(JSON.stringify({ ok: true, packs }, null, 2));
    return;
  }

  if (args.cmd === 'describe') {
    if (!args.packId) throw new Error('Missing pipeId. Usage: describe <pipeId>');
    const info = await describePack(args.packId);
    console.log(JSON.stringify({ ok: true, pack: info }, null, 2));
    return;
  }

  if (args.cmd === 'validate') {
    if (!args.packId) throw new Error('Missing pipeId. Usage: validate <pipeId>');
    const res = await validatePack(args.packId);
    console.log(JSON.stringify({ ok: res.ok, validation: res }, null, 2));
    if (!res.ok) process.exitCode = 2;
    return;
  }

  if (args.cmd === 'doctor') {
    if (!args.packId) throw new Error('Missing pipeId. Usage: doctor <pipeId>');
    const res = await doctorPack(args.packId, { limit: args.limit });
    console.log(JSON.stringify({ ok: res.ok, diagnosis: res }, null, 2));
    return;
  }

  if (args.cmd === 'sync-check') {
    if (!args.packId) throw new Error('Missing pipeId. Usage: sync-check <pipeId>');
    const res = await syncCheckPack(args.packId);
    console.log(JSON.stringify({ ok: res.ok, sync: res }, null, 2));
    if (!res.ok) process.exitCode = 3;
    return;
  }

  if (args.cmd === 'sync-lock') {
    if (!args.packId) throw new Error('Missing pipeId. Usage: sync-lock <pipeId>');
    const res = await syncLockPack(args.packId);
    console.log(JSON.stringify({ ok: res.ok, sync: res }, null, 2));
    return;
  }

  if (args.cmd === 'scaffold') {
    if (!args.packId) throw new Error('Missing pipeId. Usage: scaffold <pipeId>');
    const res = await scaffoldPipe(args.packId, { baseDir: args.baseDir });
    console.log(JSON.stringify(res, null, 2));
    return;
  }

  if (args.cmd === 'runs') {
    if (args.summaryOnly) {
      const res = await summarizeRuns({ limit: args.limit });
      console.log(JSON.stringify({ ok: true, ...res }, null, 2));
      return;
    }

    if (args.trends) {
      const res = await runTrends({ limit: args.limit });
      console.log(JSON.stringify({ ok: true, ...res }, null, 2));
      return;
    }

    const runs = await listRuns({ limit: args.limit });
    console.log(JSON.stringify({ ok: true, runs }, null, 2));
    return;
  }

  if (args.cmd === 'run') {
    if (!args.packId) throw new Error('Missing pipeId. Usage: run <pipeId>');
    const res = await runPack(args.packId, args);
    console.log(JSON.stringify(res, null, 2));
    return;
  }

  throw new Error(`Unknown command: ${args.cmd}`);
}

main().catch((e) => {
  console.error(e?.stack || String(e));
  process.exit(1);
});

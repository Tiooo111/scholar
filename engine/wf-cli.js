#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

function parseArgs(argv) {
  const out = {
    cmd: argv[0] || 'help',
    packId: argv[1] || null,
    runDir: null,
    maxSteps: null,
    dryRun: false,
    injectDeviation: null,
  };

  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--run-dir') out.runDir = argv[++i];
    else if (a === '--max-steps') out.maxSteps = Number(argv[++i]);
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--inject-deviation') out.injectDeviation = argv[++i];
  }

  return out;
}

async function listPacks() {
  const base = path.resolve('packs');
  try {
    const dirs = await fs.readdir(base, { withFileTypes: true });
    return dirs.filter((d) => d.isDirectory()).map((d) => d.name).sort();
  } catch {
    return [];
  }
}

async function runPack(packId, opts = {}) {
  const safe = /^[a-zA-Z0-9._-]+$/.test(packId || '');
  if (!safe) throw new Error(`Invalid packId: ${packId}`);

  const workflow = path.resolve('packs', packId, 'workflow.yaml');
  const args = ['engine/wf-runner.js', '--workflow', workflow];
  if (opts.runDir) args.push('--run-dir', String(opts.runDir));
  if (Number.isFinite(opts.maxSteps)) args.push('--max-steps', String(opts.maxSteps));
  if (opts.dryRun) args.push('--dry-run');
  if (opts.injectDeviation) args.push('--inject-deviation', String(opts.injectDeviation));

  const { stdout, stderr } = await execFileP('node', args, { cwd: process.cwd(), timeout: 10 * 60 * 1000 });
  const text = String(stdout || '').trim();
  let result;
  try {
    result = JSON.parse(text);
  } catch {
    const s = text.indexOf('{');
    const e = text.lastIndexOf('}');
    result = JSON.parse(s >= 0 && e > s ? text.slice(s, e + 1) : '{}');
  }
  return { ...result, stderr: String(stderr || '') };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.cmd === 'help' || args.cmd === '--help' || args.cmd === '-h') {
    console.log(`Usage:\n  node engine/wf-cli.js list\n  node engine/wf-cli.js run <packId> [--dry-run] [--run-dir <dir>] [--max-steps <n>] [--inject-deviation <type>]`);
    return;
  }

  if (args.cmd === 'list') {
    const packs = await listPacks();
    console.log(JSON.stringify({ ok: true, packs }, null, 2));
    return;
  }

  if (args.cmd === 'run') {
    if (!args.packId) throw new Error('Missing packId. Usage: run <packId>');
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

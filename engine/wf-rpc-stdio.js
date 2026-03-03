#!/usr/bin/env node
import readline from 'node:readline';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import fs from 'node:fs/promises';

const execFileP = promisify(execFile);

function safePackId(packId) {
  return /^[a-zA-Z0-9._-]+$/.test(packId || '');
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

async function runPack(params = {}) {
  const packId = params.packId;
  if (!safePackId(packId)) throw new Error('invalid_pack_id');

  const workflow = path.resolve('packs', packId, 'workflow.yaml');
  const args = ['engine/wf-runner.js', '--workflow', workflow];
  if (params.runDir) args.push('--run-dir', String(params.runDir));
  if (Number.isFinite(params.maxSteps)) args.push('--max-steps', String(params.maxSteps));
  if (params.dryRun) args.push('--dry-run');
  if (params.injectDeviation) args.push('--inject-deviation', String(params.injectDeviation));

  const { stdout } = await execFileP('node', args, { cwd: process.cwd(), timeout: 10 * 60 * 1000 });
  const text = String(stdout || '').trim();
  try {
    return JSON.parse(text);
  } catch {
    const s = text.indexOf('{');
    const e = text.lastIndexOf('}');
    return JSON.parse(s >= 0 && e > s ? text.slice(s, e + 1) : '{}');
  }
}

function respond(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on('line', async (line) => {
  let req;
  try {
    req = JSON.parse(line);
  } catch {
    return respond({ id: null, error: 'invalid_json' });
  }

  const id = req.id ?? null;
  try {
    if (req.method === 'list_workflows') {
      const packs = await listPacks();
      return respond({ id, result: { packs } });
    }
    if (req.method === 'run_workflow') {
      const result = await runPack(req.params || {});
      return respond({ id, result });
    }

    return respond({ id, error: 'unknown_method' });
  } catch (e) {
    return respond({ id, error: String(e?.message || e) });
  }
});

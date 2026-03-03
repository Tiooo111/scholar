import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

export function isSafePackId(packId) {
  return /^[a-zA-Z0-9._-]+$/.test(packId || '');
}

export async function listPacks(baseDir = 'packs') {
  const base = path.resolve(baseDir);
  try {
    const dirs = await fs.readdir(base, { withFileTypes: true });
    return dirs.filter((d) => d.isDirectory()).map((d) => d.name).sort();
  } catch {
    return [];
  }
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

export async function runPack(packId, opts = {}) {
  if (!isSafePackId(packId)) {
    throw new Error(`invalid_pack_id:${packId}`);
  }

  const workflow = path.resolve('packs', packId, 'workflow.yaml');
  const args = ['engine/wf-runner.js', '--workflow', workflow];

  if (opts.runDir) args.push('--run-dir', String(opts.runDir));
  if (opts.resumeRunDir) args.push('--resume-run-dir', String(opts.resumeRunDir));
  if (Number.isFinite(opts.maxSteps)) args.push('--max-steps', String(opts.maxSteps));
  if (opts.dryRun) args.push('--dry-run');
  if (opts.injectDeviation) args.push('--inject-deviation', String(opts.injectDeviation));

  const { stdout, stderr } = await execFileP('node', args, {
    cwd: process.cwd(),
    timeout: 10 * 60 * 1000,
  });

  return {
    ...parseRunnerOutput(stdout),
    stderr: String(stderr || ''),
  };
}

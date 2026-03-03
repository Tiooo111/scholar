#!/usr/bin/env node
import { listPacks, runPack } from './wf-core.js';

function parseArgs(argv) {
  const out = {
    cmd: argv[0] || 'help',
    packId: argv[1] || null,
    runDir: null,
    resumeRunDir: null,
    maxSteps: null,
    dryRun: false,
    injectDeviation: null,
  };

  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--run-dir') out.runDir = argv[++i];
    else if (a === '--resume-run-dir') out.resumeRunDir = argv[++i];
    else if (a === '--max-steps') out.maxSteps = Number(argv[++i]);
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--inject-deviation') out.injectDeviation = argv[++i];
  }

  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.cmd === 'help' || args.cmd === '--help' || args.cmd === '-h') {
    console.log(`Usage:\n  wf list\n  wf run <packId> [--dry-run] [--run-dir <dir>] [--resume-run-dir <dir>] [--max-steps <n>] [--inject-deviation <type>]`);
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

#!/usr/bin/env node
import readline from 'node:readline';
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

function respond(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
let queue = Promise.resolve();

async function handleLine(line) {
  let req;
  try {
    req = JSON.parse(line);
  } catch {
    return respond({ id: null, error: 'invalid_json' });
  }

  const id = req.id ?? null;
  try {
    if (req.method === 'list_workflows') {
      const params = req.params || {};
      if (params.details) {
        const packs = await listPackDetails();
        return respond({ id, result: { packs } });
      }
      const packs = await listPacks();
      return respond({ id, result: { packs } });
    }

    if (req.method === 'describe_workflow') {
      const params = req.params || {};
      const packId = params.packId;
      const pack = await describePack(packId);
      return respond({ id, result: { pack } });
    }

    if (req.method === 'validate_workflow') {
      const params = req.params || {};
      const packId = params.packId;
      const validation = await validatePack(packId);
      return respond({ id, result: { ok: validation.ok, validation } });
    }

    if (req.method === 'scaffold_workflow') {
      const params = req.params || {};
      const packId = params.packId;
      const baseDir = params.baseDir || 'pipes';
      const result = await scaffoldPipe(packId, { baseDir });
      return respond({ id, result });
    }

    if (req.method === 'list_runs') {
      const params = req.params || {};
      const limit = Number(params.limit || 20);
      const runs = await listRuns({ limit });
      return respond({ id, result: { runs } });
    }

    if (req.method === 'summarize_runs') {
      const params = req.params || {};
      const limit = Number(params.limit || 50);
      const result = await summarizeRuns({ limit });
      return respond({ id, result });
    }

    if (req.method === 'run_trends') {
      const params = req.params || {};
      const limit = Number(params.limit || 200);
      const result = await runTrends({ limit });
      return respond({ id, result });
    }

    if (req.method === 'doctor_workflow') {
      const params = req.params || {};
      const packId = params.packId;
      const limit = Number(params.limit || 50);
      const diagnosis = await doctorPack(packId, { limit });
      return respond({ id, result: { ok: diagnosis.ok, diagnosis } });
    }

    if (req.method === 'sync_check_workflow') {
      const params = req.params || {};
      const packId = params.packId;
      const sync = await syncCheckPack(packId);
      return respond({ id, result: { ok: sync.ok, sync } });
    }

    if (req.method === 'sync_lock_workflow') {
      const params = req.params || {};
      const packId = params.packId;
      const sync = await syncLockPack(packId);
      return respond({ id, result: { ok: sync.ok, sync } });
    }

    if (req.method === 'run_workflow') {
      const params = req.params || {};
      const packId = params.packId;
      const result = await runPack(packId, params);
      return respond({ id, result });
    }

    return respond({ id, error: 'unknown_method' });
  } catch (e) {
    return respond({ id, error: String(e?.message || e) });
  }
}

rl.on('line', (line) => {
  queue = queue.then(() => handleLine(line)).catch((e) => {
    respond({ id: null, error: String(e?.message || e) });
  });
});

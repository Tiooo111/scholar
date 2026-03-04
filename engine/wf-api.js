#!/usr/bin/env node
import http from 'node:http';
import { URL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs/promises';
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

const PORT = Number(process.env.WF_API_PORT || 8787);

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body, null, 2));
}

function classifyError(err) {
  const msg = String(err?.message || err || 'unknown_error');
  if (msg.startsWith('invalid_pack_id:')) return { status: 400, code: 'invalid_pack_id', message: msg };
  if (msg.startsWith('workflow_not_found:')) return { status: 404, code: 'workflow_not_found', message: msg };
  if (msg.startsWith('pipe_already_exists:')) return { status: 409, code: 'pipe_already_exists', message: msg };
  if (msg.startsWith('input_validation_error:')) {
    return {
      status: 400,
      code: 'input_validation_error',
      message: msg,
    };
  }
  if (msg.startsWith('workflow_validation_error:')) {
    return {
      status: 422,
      code: 'workflow_validation_error',
      message: msg,
    };
  }
  return { status: 500, code: 'internal_error', message: msg };
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf-8').trim();
  if (!raw) return {};
  return JSON.parse(raw);
}

function buildRunOptions(body = {}) {
  const out = {
    runDir: body.runDir,
    resumeRunDir: body.resumeRunDir,
    maxSteps: body.maxSteps,
    dryRun: body.dryRun,
    injectDeviation: body.injectDeviation,
    inputs: body.inputs,
  };

  return out;
}

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

    if (req.method === 'GET' && u.pathname === '/health') {
      return json(res, 200, { ok: true, service: 'wf-api', port: PORT });
    }

    if (req.method === 'GET' && u.pathname === '/openapi.yaml') {
      const p = path.resolve('engine', 'openapi.yaml');
      const body = await fs.readFile(p, 'utf-8');
      res.writeHead(200, { 'content-type': 'application/yaml; charset=utf-8' });
      res.end(body);
      return;
    }

    if (req.method === 'GET' && u.pathname === '/runs') {
      const limit = Number(u.searchParams.get('limit') || 20);
      const runs = await listRuns({ limit });
      return json(res, 200, { ok: true, runs });
    }

    if (req.method === 'GET' && u.pathname === '/runs/summary') {
      const limit = Number(u.searchParams.get('limit') || 50);
      const out = await summarizeRuns({ limit });
      return json(res, 200, { ok: true, ...out });
    }

    if (req.method === 'GET' && u.pathname === '/runs/trends') {
      const limit = Number(u.searchParams.get('limit') || 200);
      const out = await runTrends({ limit });
      return json(res, 200, { ok: true, ...out });
    }

    if (req.method === 'POST' && u.pathname === '/workflows/scaffold') {
      const body = await readJsonBody(req);
      const packId = body?.packId;
      const baseDir = body?.baseDir || 'pipes';
      const out = await scaffoldPipe(packId, { baseDir });
      return json(res, 200, { ok: true, result: out });
    }

    if (req.method === 'GET' && (u.pathname === '/workflows' || u.pathname === '/pipes')) {
      const details = String(u.searchParams.get('details') || '').toLowerCase();
      if (details === '1' || details === 'true') {
        const packs = await listPackDetails();
        return json(res, 200, { ok: true, packs });
      }

      const packs = await listPacks();
      return json(res, 200, { ok: true, packs });
    }

    if (req.method === 'GET' && (u.pathname.startsWith('/workflows/') || u.pathname.startsWith('/pipes/'))) {
      const m = u.pathname.match(/^\/(?:workflows|pipes)\/([^/]+)$/);
      if (m) {
        const packId = m[1];
        const pack = await describePack(packId);
        return json(res, 200, { ok: true, packId, pack });
      }
    }

    if (req.method === 'GET' && (u.pathname.startsWith('/workflows/') || u.pathname.startsWith('/pipes/'))) {
      const m = u.pathname.match(/^\/(?:workflows|pipes)\/([^/]+)\/validate$/);
      if (m) {
        const packId = m[1];
        const validation = await validatePack(packId);
        return json(res, validation.ok ? 200 : 422, { ok: validation.ok, packId, validation });
      }
    }

    if (req.method === 'GET' && (u.pathname.startsWith('/workflows/') || u.pathname.startsWith('/pipes/'))) {
      const m = u.pathname.match(/^\/(?:workflows|pipes)\/([^/]+)\/doctor$/);
      if (m) {
        const packId = m[1];
        const limit = Number(u.searchParams.get('limit') || 50);
        const diagnosis = await doctorPack(packId, { limit });
        return json(res, 200, { ok: diagnosis.ok, packId, diagnosis });
      }
    }

    if (req.method === 'GET' && (u.pathname.startsWith('/workflows/') || u.pathname.startsWith('/pipes/'))) {
      const m = u.pathname.match(/^\/(?:workflows|pipes)\/([^/]+)\/sync-check$/);
      if (m) {
        const packId = m[1];
        const sync = await syncCheckPack(packId);
        return json(res, sync.ok ? 200 : 409, { ok: sync.ok, packId, sync });
      }
    }

    if (req.method === 'POST' && (u.pathname.startsWith('/workflows/') || u.pathname.startsWith('/pipes/'))) {
      const m = u.pathname.match(/^\/(?:workflows|pipes)\/([^/]+)\/sync-lock$/);
      if (m) {
        const packId = m[1];
        const sync = await syncLockPack(packId);
        return json(res, 200, { ok: sync.ok, packId, sync });
      }
    }

    if (req.method === 'POST' && (u.pathname.startsWith('/workflows/') || u.pathname.startsWith('/pipes/'))) {
      const m = u.pathname.match(/^\/(?:workflows|pipes)\/([^/]+)\/run$/);
      if (!m) return json(res, 404, { ok: false, error: 'not_found' });

      const packId = m[1];
      const body = await readJsonBody(req);
      const out = await runPack(packId, buildRunOptions(body));
      return json(res, 200, { ok: true, packId, result: out });
    }

    return json(res, 404, { ok: false, error: 'not_found' });
  } catch (e) {
    const err = classifyError(e);
    return json(res, err.status, { ok: false, error: err.code, message: err.message });
  }
});

server.listen(PORT, () => {
  console.log(JSON.stringify({ ok: true, service: 'wf-api', port: PORT }));
});

#!/usr/bin/env node
import http from 'node:http';
import { URL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

const execFileP = promisify(execFile);

const PORT = Number(process.env.WF_API_PORT || 8787);

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body, null, 2));
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf-8').trim();
  if (!raw) return {};
  return JSON.parse(raw);
}

function safePackId(packId) {
  return /^[a-zA-Z0-9._-]+$/.test(packId || '');
}

async function runPack(packId, body = {}) {
  if (!safePackId(packId)) throw new Error('invalid_pack_id');
  const workflow = path.resolve('packs', packId, 'workflow.yaml');

  const args = ['engine/wf-runner.js', '--workflow', workflow];
  if (body.runDir) args.push('--run-dir', String(body.runDir));
  if (Number.isFinite(body.maxSteps)) args.push('--max-steps', String(body.maxSteps));
  if (body.dryRun) args.push('--dry-run');
  if (body.injectDeviation) args.push('--inject-deviation', String(body.injectDeviation));

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

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

    if (req.method === 'GET' && u.pathname === '/health') {
      return json(res, 200, { ok: true, service: 'wf-api', port: PORT });
    }

    if (req.method === 'POST' && u.pathname.startsWith('/workflows/')) {
      const m = u.pathname.match(/^\/workflows\/([^/]+)\/run$/);
      if (!m) return json(res, 404, { ok: false, error: 'not_found' });

      const packId = m[1];
      const body = await readJsonBody(req);
      const out = await runPack(packId, body);
      return json(res, 200, { ok: true, packId, result: out });
    }

    return json(res, 404, { ok: false, error: 'not_found' });
  } catch (e) {
    return json(res, 500, { ok: false, error: String(e?.message || e) });
  }
});

server.listen(PORT, () => {
  console.log(JSON.stringify({ ok: true, service: 'wf-api', port: PORT }));
});

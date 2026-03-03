import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readJson, ymdInTz } from './lib.js';

const execFileP = promisify(execFile);

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

function parseArgs(argv) {
  const args = { kind: 'daily', dryRun: false, force: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!args.kind && !a.startsWith('-')) args.kind = a;
    else if (a === '--kind') args.kind = argv[++i];
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--force') args.force = true;
  }
  // positional: node run_job.js daily
  const pos = argv.find((x) => !x.startsWith('-'));
  if (pos && !['--kind', '--dry-run', '--force'].includes(pos)) args.kind = pos;
  return args;
}

async function loadLocalConfig() {
  const p = path.join(ROOT, 'config', 'local.json');
  if (!(await exists(p))) return null;
  return readJson(p);
}

async function runNode(script, args = []) {
  const p = path.join(ROOT, 'scripts', script);
  const { stdout, stderr } = await execFileP('node', [p, ...args], { cwd: ROOT, timeout: 15 * 60 * 1000 });
  return { stdout, stderr };
}

async function sendWhatsapp({ to, message, mediaPath, dryRun }) {
  if (dryRun) {
    return { ok: true, skipped: true, to, message, mediaPath };
  }

  const argv = ['message', 'send', '--channel', 'whatsapp', '--target', to, '--message', message];
  if (mediaPath) argv.push('--media', mediaPath);

  const { stdout, stderr } = await execFileP('openclaw', argv, { cwd: ROOT, timeout: 60 * 1000 });
  return { ok: true, stdout, stderr };
}

async function publishMarkdownReport(mdPath, dryRun) {
  if (dryRun) return null;

  const text = await fs.readFile(mdPath, 'utf-8');
  const editCode = `scholar-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const body = new URLSearchParams({ text, edit_code: editCode });

  const res = await fetch('https://rentry.co/api/new', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Referer': 'https://rentry.co'
    },
    body
  });

  const json = await res.json().catch(() => ({}));
  if (!res.ok || String(json.status) !== '200' || !json.url) {
    throw new Error(`rentry publish failed: http=${res.status} body=${JSON.stringify(json)}`);
  }

  return { url: json.url, editCode };
}


async function main() {
  const args = parseArgs(process.argv.slice(2));
  const kind = String(args.kind || 'daily').toLowerCase();

  const local = await loadLocalConfig();
  const to = local?.delivery?.to || process.env.SCHOLAR_WHATSAPP_TARGET;
  if (!to) {
    console.error('Missing WhatsApp target. Set radar/config/local.json delivery.to or SCHOLAR_WHATSAPP_TARGET env.');
    process.exit(2);
  }

  const settings = await readJson(path.join(ROOT, 'config', 'settings.json'));
  const tz = settings.timezone || 'Asia/Shanghai';

  // Guard: monthly report only runs on the last day of month (unless --force).
  if (kind === 'monthly' && !args.force) {
    const now = new Date();
    const today = ymdInTz(now, tz);
    const tomorrow = ymdInTz(new Date(now.getTime() + 24 * 3600 * 1000), tz);
    if (today.slice(0, 7) === tomorrow.slice(0, 7)) {
      console.log(JSON.stringify({ ok: true, skipped: true, kind, reason: 'not_last_day_of_month', date: today, tz }, null, 2));
      return;
    }
  }

  // 1) Fetch + rank
  const r1 = await runNode('fetch_and_rank.js', ['--kind', kind]);
  const j1 = JSON.parse(r1.stdout.trim().split('\n').pop());

  const selectedPath = path.resolve(ROOT, j1.selectedPath);
  const selected = await readJson(selectedPath);

  // 2) Enrich (three-block description)
  const enrichedPath = selectedPath.replace(/\.selected\.json$/i, '.enriched.json');
  await runNode('enrich_selected.js', ['--in', selectedPath, '--out', enrichedPath, '--kind', kind]);
  const enriched = await readJson(enrichedPath);

  // 3) Render poster (concise image content)
  const posterPath = selectedPath.replace(/\.selected\.json$/i, '.poster.png');
  await runNode('render_poster.js', ['--in', enrichedPath, '--out', posterPath]);

  // 4) Build full detailed markdown report
  const reportPath = selectedPath.replace(/\.selected\.json$/i, '.report.md');
  await runNode('write_report_md.js', ['--in', enrichedPath, '--out', reportPath]);

  // 5) Download PDFs
  const papersDir = path.join(ROOT, 'papers', kind, selected.date || j1.date);
  await runNode('download_pdfs.js', ['--in', selectedPath, '--outdir', papersDir]);

  // 6) Send to WhatsApp
  // openclaw message send restricts local media paths to safe allowlisted roots.
  // Stage the poster/report into the main workspace to satisfy the allowlist.
  const stageRoot = '/home/node/.openclaw/workspace/media-out/scholar-radar';
  const stageDir = path.join(stageRoot, kind, enriched.date || selected.date || j1.date);
  await fs.mkdir(stageDir, { recursive: true });
  const stagedPoster = path.join(stageDir, path.basename(posterPath));
  await fs.copyFile(posterPath, stagedPoster);

  const stagedReport = path.join(stageDir, path.basename(reportPath));
  await fs.copyFile(reportPath, stagedReport);

  const reportPub = await publishMarkdownReport(stagedReport, args.dryRun);

  // Per user preference: only send image + link (no extra text block).
  // Use zero-width text so media send can proceed without visible caption.
  await sendWhatsapp({ to, message: '\u200B', mediaPath: stagedPoster, dryRun: args.dryRun });

  if (reportPub?.url) {
    await sendWhatsapp({
      to,
      message: reportPub.url,
      mediaPath: null,
      dryRun: args.dryRun
    });
  }

  console.log(JSON.stringify({ ok: true, kind, to, selectedPath, enrichedPath, posterPath, reportPath, reportUrl: reportPub?.url || null, papersDir, count: selected.count }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';

const runDir = process.env.WF_RUN_DIR;
if (!runDir) {
  console.error('WF_RUN_DIR is required');
  process.exit(2);
}

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

const required = ['requirements.md', 'workflow.yaml', 'roles.yaml', 'tasks.yaml'];
const missing = [];
for (const f of required) {
  if (!(await exists(path.join(runDir, f)))) missing.push(f);
}

const verification = missing.length
  ? '# verification_report.md\n\nstatus: fail\nchecks:\n- name: required_artifacts\n  result: fail\n'
  : '# verification_report.md\n\nstatus: pass\nchecks:\n- name: required_artifacts\n  result: pass\n';

const deviation = missing.length
  ? `# deviation_report.md\n\nStatus: has_deviation\nType: verification_gap\nSeverity: medium\nEvidence: missing ${missing.join(', ')}\n`
  : '# deviation_report.md\n\nStatus: no_deviation\n';

await fs.writeFile(path.join(runDir, 'verification_report.md'), verification, 'utf-8');
await fs.writeFile(path.join(runDir, 'deviation_report.md'), deviation, 'utf-8');

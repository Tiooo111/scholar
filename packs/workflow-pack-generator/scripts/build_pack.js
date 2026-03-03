#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';

const runDir = process.env.WF_RUN_DIR;
if (!runDir) {
  console.error('WF_RUN_DIR is required');
  process.exit(2);
}

const generated = path.join(runDir, 'generated_pack');
await fs.mkdir(generated, { recursive: true });
await fs.writeFile(path.join(runDir, 'implementation_delta.md'), '# implementation_delta.md\n\n- builder script executed\n', 'utf-8');
await fs.writeFile(path.join(generated, 'README.md'), '# generated_pack\n\nThis is a script-executor generated pack stub.\n', 'utf-8');

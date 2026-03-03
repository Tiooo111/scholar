#!/usr/bin/env node
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { listPacks, runPack } from './wf-core.js';

const server = new McpServer({
  name: 'scholar-workflow-engine',
  version: '0.1.0',
});

server.tool(
  'list_workflows',
  'List available workflow packs',
  {},
  async () => {
    const packs = await listPacks();
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ ok: true, packs }, null, 2),
        },
      ],
    };
  }
);

server.tool(
  'run_workflow',
  'Run a workflow pack by packId',
  {
    packId: z.string().min(1),
    dryRun: z.boolean().optional(),
    runDir: z.string().optional(),
    resumeRunDir: z.string().optional(),
    maxSteps: z.number().int().positive().optional(),
    injectDeviation: z
      .enum([
        'requirements_mismatch',
        'architecture_mismatch',
        'implementation_bug',
        'verification_gap',
      ])
      .optional(),
  },
  async (args) => {
    const result = await runPack(args.packId, args);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ ok: true, packId: args.packId, result }, null, 2),
        },
      ],
    };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);

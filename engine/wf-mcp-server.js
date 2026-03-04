#!/usr/bin/env node
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
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

const server = new McpServer({
  name: 'openpipe-workflow-engine',
  version: '0.3.0',
});

server.tool(
  'list_workflows',
  'List available workflow packs',
  {
    details: z.boolean().optional(),
  },
  async (args) => {
    const packs = args?.details ? await listPackDetails() : await listPacks();
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
  'describe_workflow',
  'Describe a workflow pack and its input/output contract',
  {
    packId: z.string().min(1),
  },
  async (args) => {
    const pack = await describePack(args.packId);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ ok: true, packId: args.packId, pack }, null, 2),
        },
      ],
    };
  }
);

server.tool(
  'validate_workflow',
  'Validate workflow graph, role bindings, and contract references',
  {
    packId: z.string().min(1),
  },
  async (args) => {
    const validation = await validatePack(args.packId);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ ok: validation.ok, packId: args.packId, validation }, null, 2),
        },
      ],
    };
  }
);

server.tool(
  'sync_check_workflow',
  'Check whether logic/workflow files are in sync with governance lock',
  {
    packId: z.string().min(1),
  },
  async (args) => {
    const sync = await syncCheckPack(args.packId);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ ok: sync.ok, packId: args.packId, sync }, null, 2),
        },
      ],
    };
  }
);

server.tool(
  'sync_lock_workflow',
  'Regenerate governance lock after intentional workflow/logic updates',
  {
    packId: z.string().min(1),
  },
  async (args) => {
    const sync = await syncLockPack(args.packId);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ ok: sync.ok, packId: args.packId, sync }, null, 2),
        },
      ],
    };
  }
);

server.tool(
  'scaffold_workflow',
  'Scaffold a new workflow pipe under pipes/',
  {
    packId: z.string().min(1),
    baseDir: z.string().optional(),
  },
  async (args) => {
    const result = await scaffoldPipe(args.packId, { baseDir: args.baseDir || 'pipes' });
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ ok: result.ok, packId: args.packId, result }, null, 2),
        },
      ],
    };
  }
);

server.tool(
  'list_runs',
  'List recent workflow run reports',
  {
    limit: z.number().int().positive().optional(),
  },
  async (args) => {
    const runs = await listRuns({ limit: args.limit || 20 });
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ ok: true, runs }, null, 2),
        },
      ],
    };
  }
);

server.tool(
  'summarize_runs',
  'Summarize recent runs by workflow and termination reason',
  {
    limit: z.number().int().positive().optional(),
  },
  async (args) => {
    const result = await summarizeRuns({ limit: args.limit || 50 });
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ ok: true, ...result }, null, 2),
        },
      ],
    };
  }
);

server.tool(
  'run_trends',
  'Show run trends grouped by UTC day',
  {
    limit: z.number().int().positive().optional(),
  },
  async (args) => {
    const result = await runTrends({ limit: args.limit || 200 });
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ ok: true, ...result }, null, 2),
        },
      ],
    };
  }
);

server.tool(
  'doctor_workflow',
  'Diagnose workflow quality using validation + recent run health',
  {
    packId: z.string().min(1),
    limit: z.number().int().positive().optional(),
  },
  async (args) => {
    const diagnosis = await doctorPack(args.packId, { limit: args.limit || 50 });
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ ok: diagnosis.ok, packId: args.packId, diagnosis }, null, 2),
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
    inputs: z.record(z.any()).optional(),
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

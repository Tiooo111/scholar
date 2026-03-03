# Workflow Engine (v0.2)

This folder contains the execution layer for workflow packs.

New in v0.2:
- Contract validation from `contracts/contract-rules.yaml`
- Execution state checkpoints (`execution_state.json`)
- Resume support (`--resume-run-dir`)
- Event stream log (`execution_events.jsonl`)

## 1) CLI

List packs:

```bash
npm run wf:list
```

Run a pack:

```bash
node engine/wf-cli.js run workflow-pack-generator
# or
npm run wf:run -- workflow-pack-generator
```

Optional global command (from repo root, if your environment allows `npm link`):

```bash
npm link
wf list
wf run workflow-pack-generator --dry-run
```

If `npm link` is restricted, keep using:

```bash
node engine/wf-cli.js <command>
```

Optional flags:

- `--dry-run`
- `--run-dir <path>`
- `--max-steps <n>`
- `--resume-run-dir <path>` (resume from saved `execution_state.json`)
- `--inject-deviation <requirements_mismatch|architecture_mismatch|implementation_bug|verification_gap>`

## 2) REST API

Start server:

```bash
npm run wf:api
```

Health check:

```bash
curl http://127.0.0.1:8787/health
```

OpenAPI spec:

```bash
curl http://127.0.0.1:8787/openapi.yaml
```

Run workflow pack:

```bash
curl -X POST http://127.0.0.1:8787/workflows/workflow-pack-generator/run \
  -H 'content-type: application/json' \
  -d '{"dryRun": true}'
```

## 3) StdIO RPC (lightweight)

Start server:

```bash
npm run wf:rpc
```

Methods (JSON line protocol):

- `list_workflows`
- `run_workflow` with params `{ packId, dryRun, runDir, resumeRunDir, maxSteps, injectDeviation }`

Example request line:

```json
{"id":1,"method":"run_workflow","params":{"packId":"workflow-pack-generator","dryRun":true}}
```

## 4) MCP Server (tool integration)

Start MCP stdio server:

```bash
npm run wf:mcp
```

Exposed MCP tools:

- `list_workflows`
- `run_workflow`

This lets external MCP clients call workflow packs directly without going through REST.

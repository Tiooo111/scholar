# Workflow Engine (v0)

This folder contains the minimal execution layer for workflow packs.

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

Optional flags:

- `--dry-run`
- `--run-dir <path>`
- `--max-steps <n>`
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

Run workflow pack:

```bash
curl -X POST http://127.0.0.1:8787/workflows/workflow-pack-generator/run \
  -H 'content-type: application/json' \
  -d '{"dryRun": true}'
```

## 3) StdIO RPC (MCP-friendly adapter)

Start server:

```bash
npm run wf:rpc
```

Methods (JSON line protocol):

- `list_workflows`
- `run_workflow` with params `{ packId, dryRun, runDir, maxSteps, injectDeviation }`

Example request line:

```json
{"id":1,"method":"run_workflow","params":{"packId":"workflow-pack-generator","dryRun":true}}
```

# Workflow Engine (v0.2)

This folder contains the execution layer for workflow packs.

New in v0.4:
- Contract validation from `contracts/contract-rules.yaml`
- Execution state checkpoints (`execution_state.json`)
- Resume support (`--resume-run-dir`)
- Event stream log (`execution_events.jsonl`)
- Node retry/timeout/backoff policy support (workflow-defined)
- Role/Node executor plugin routing (`template` | `shell`)

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

### Executor plugin routing

Executors are resolved in this order:
1. `node.executor`
2. `roles.yaml` role-level `executor`
3. default `template`

Supported executors (v0.5):
- `template`: built-in artifact materializer
- `shell`: run a shell command in run directory
- `script`: run a Node script file
- `llm`: call OpenAI-compatible chat completion and map JSON output to declared files

Example role-level executors:

```yaml
roles:
  builder:
    executor:
      type: shell
      command: "./scripts/build_pack.sh"

  verifier:
    executor:
      type: script
      script: "scripts/verify_pack.js"
      args: ["--strict"]

  requirements-analyst:
    executor:
      type: llm
      provider: openai_compat
      model: gpt-4o-mini
      apiKeyEnv: OPENAI_API_KEY
      baseUrl: https://api.openai.com/v1
      prompt: |
        Create concise requirement artifacts for node {{nodeId}}.
```

Environment variables available to shell/script executor:
- `WF_RUN_DIR`
- `WF_PACK_ROOT`
- `WF_NODE_ID`
- `WF_ROLE`
- `WF_WORKFLOW_ID`
- `WF_RUN_ID`

For `llm` executor:
- Model response must be a JSON object mapping declared output filenames to content.
- If `--dry-run` is enabled, non-template executors automatically fall back to template materialization (no external calls).

### Runtime policy in `workflow.yaml`

You can configure global and per-node retry/timeout behavior:

```yaml
runtime:
  policy:
    timeoutMs: 12000
    retries:
      maxAttempts: 2
      backoffMs: 200
      backoffMultiplier: 2
      retryOn: [task_error, timeout, contract_violation]

nodes:
  - id: implement_tasks
    policy:
      timeoutMs: 20000
      retries:
        maxAttempts: 3
        backoffMs: 300
        backoffMultiplier: 2
        retryOn: [task_error, timeout, contract_violation]
```

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

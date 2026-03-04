# Workflow Engine (v0.7)

This folder contains the execution layer for OpenPipe pipes/workflows.

Current capabilities:
- Contract validation from `contracts/contract-rules.yaml`
- Execution state checkpoints (`execution_state.json`)
- Resume support (`--resume-run-dir`)
- Event stream log (`execution_events.jsonl`)
- Node retry/timeout/backoff policy support (workflow-defined)
- Role/Node executor plugin routing (`template` | `shell` | `script` | `llm`)
- Workflow discovery and metadata describe APIs
- Workflow input contract validation (`workflow.yaml.inputs`)
- Governance sync enforcement (`governance.sync` + lock file)

## 1) CLI

List pipes/workflows:

```bash
npm run wf:list
npm run wf:list -- --details
node engine/wf-cli.js describe metapipe
npm run wf:sync-check -- metapipe
npm run wf:validate -- metapipe
npm run wf:doctor -- metapipe
npm run wf:runs -- --summary-only
npm run wf:runs -- --trends --limit 200
```

Run a pipe:

```bash
node engine/wf-cli.js run metapipe --dry-run
# or
npm run wf:run -- metapipe --input task_prompt="Build an incident response workflow"
```

Optional global command (from repo root, if your environment allows `npm link`):

```bash
npm link
wf list
wf run metapipe --dry-run
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
- `--input key=value` (repeatable)
- `--inputs-json '{"task_prompt":"..."}'`
- `wf sync-check <pipeId>`
- `wf sync-lock <pipeId>`
- `wf doctor <pipeId> [--limit 50]`
- `wf scaffold <pipeId> [--base-dir pipes]`
- `wf runs [--limit 20] [--summary-only|--trends]`

### Executor plugin routing

Executors are resolved in this order:
1. `node.executor`
2. `roles.yaml` role-level `executor`
3. default `template`

Supported executors (v0.6):
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
- `WF_INPUTS_JSON`

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

Discover workflows:

```bash
curl http://127.0.0.1:8787/workflows
curl "http://127.0.0.1:8787/workflows?details=true"
curl http://127.0.0.1:8787/workflows/metapipe
curl http://127.0.0.1:8787/workflows/metapipe/sync-check
curl -X POST http://127.0.0.1:8787/workflows/metapipe/sync-lock
curl http://127.0.0.1:8787/workflows/metapipe/validate
curl http://127.0.0.1:8787/workflows/metapipe/doctor?limit=100
curl http://127.0.0.1:8787/runs/summary
curl http://127.0.0.1:8787/runs/trends?limit=200
```

OpenAPI spec:

```bash
curl http://127.0.0.1:8787/openapi.yaml
```

Scaffold pipe:

```bash
curl -X POST http://127.0.0.1:8787/workflows/scaffold \
  -H 'content-type: application/json' \
  -d '{"packId":"procurement-flow"}'
```

Run pipe:

```bash
curl -X POST http://127.0.0.1:8787/workflows/metapipe/run \
  -H 'content-type: application/json' \
  -d '{"inputs":{"task_prompt":"Design a support triage workflow"}}'
```

## 3) StdIO RPC (lightweight)

Start server:

```bash
npm run wf:rpc
```

Methods (JSON line protocol):

- `list_workflows` (optional params: `{ details: true }`)
- `describe_workflow` with params `{ packId }`
- `sync_check_workflow` with params `{ packId }`
- `sync_lock_workflow` with params `{ packId }`
- `validate_workflow` with params `{ packId }`
- `doctor_workflow` with params `{ packId, limit? }`
- `scaffold_workflow` with params `{ packId, baseDir? }`
- `list_runs` with params `{ limit? }`
- `summarize_runs` with params `{ limit? }`
- `run_trends` with params `{ limit? }`
- `run_workflow` with params `{ packId, dryRun, runDir, resumeRunDir, maxSteps, injectDeviation, inputs }`

Example request line:

```json
{"id":1,"method":"run_workflow","params":{"packId":"metapipe","inputs":{"task_prompt":"Create an onboarding workflow"}}}
```

## 4) MCP Server (tool integration)

Start MCP stdio server:

```bash
npm run wf:mcp
```

Exposed MCP tools:

- `list_workflows`
- `describe_workflow`
- `sync_check_workflow`
- `sync_lock_workflow`
- `validate_workflow`
- `doctor_workflow`
- `scaffold_workflow`
- `list_runs`
- `summarize_runs`
- `run_trends`
- `run_workflow`

This lets external MCP clients call OpenPipe pipes directly without going through REST.

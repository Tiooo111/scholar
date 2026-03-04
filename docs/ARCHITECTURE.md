# OpenPipe Architecture

## Layers

### 1) Runtime Engine (`engine/`)
- `wf-runner.js`: workflow execution core
- `wf-cli.js`: CLI surface
- `wf-api.js`: REST API surface
- `wf-rpc-stdio.js`: stdio JSON-RPC surface
- `wf-mcp-server.js`: MCP tool surface
- `wf-core.js`: shared discovery/validate/run utilities

Responsibilities:
- Node execution (task/gate/router)
- Retry/timeout/backoff policy
- Contract validation (rules + schema)
- Input contract validation (`workflow.yaml.inputs`)
- Governance sync enforcement (workflow-as-law with lock file)
- Checkpoint/resume
- Event/audit output
- Executor plugin routing (`template`, `shell`, `script`, `llm`)
- Discovery/describe APIs for workflow metadata
- Preflight validation APIs for workflow graph/contracts

### 2) Pipes (`pipes/<pipe-id>/`)
- `workflow.yaml`: orchestration graph + policy
- `roles.yaml`: role definition + executor defaults
- `tasks.yaml`: task breakdown
- `contracts/`: validation rules and schemas
- `templates/`: deterministic content templates
- `scripts/`: optional script executors

Primary pipes:
- `metapipe` (meta generator)
- `scholar-radar` (example business pipe)

### 3) Compatibility Layer (`packs/`)
- Reserved for legacy/compatibility migration

## Execution Model

1. Resolve pipe workflow
2. Load roles + contracts
3. Execute entry node
4. For each node:
   - task: run executor and validate outputs
   - gate: evaluate checks
   - router: route by deviation type
5. Persist state/events after each step
6. Produce final report + artifacts

## Deviation Loop

Deviations are classified and routed back to designated stages/roles:
- requirements mismatch -> requirements stage
- architecture mismatch -> design stage
- implementation bug -> build stage
- verification gap -> verify stage

## Invocation Surfaces

- CLI (`wf list|describe|sync-check|sync-lock|validate|doctor|scaffold|runs|run`)
- REST (`/workflows`, `/workflows/scaffold`, `/workflows/:packId`, `/workflows/:packId/sync-check`, `/workflows/:packId/sync-lock`, `/workflows/:packId/validate`, `/workflows/:packId/doctor`, `/workflows/:packId/run`, `/runs`, `/runs/summary`, `/runs/trends`)
- StdIO RPC (`list_workflows`, `describe_workflow`, `sync_check_workflow`, `sync_lock_workflow`, `validate_workflow`, `doctor_workflow`, `scaffold_workflow`, `list_runs`, `summarize_runs`, `run_trends`, `run_workflow`)
- MCP tools (`list_workflows`, `describe_workflow`, `sync_check_workflow`, `sync_lock_workflow`, `validate_workflow`, `doctor_workflow`, `scaffold_workflow`, `list_runs`, `summarize_runs`, `run_trends`, `run_workflow`)

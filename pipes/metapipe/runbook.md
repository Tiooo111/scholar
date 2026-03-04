# Runbook

## Invocation
- CLI: `wf validate metapipe` then `wf run metapipe --input task_prompt="..."` (or `--dry-run` for synthetic placeholder input)
- API: `GET /workflows/metapipe/validate`, then `POST /workflows/metapipe/run` with JSON body `{ "inputs": { "task_prompt": "..." } }`
- StdIO RPC / MCP: `validate_workflow` then `run_workflow` with params like `{ "packId": "metapipe", "inputs": { "task_prompt": "..." } }`

## Stage Gates
1. Alignment gate must pass before Design.
2. Design gate must pass before Build.
3. Verification must produce deviation classification.
4. Operability optimization stage must produce risk/SLO/ADR artifacts.
5. Orchestrator routes deviations by matrix and re-runs impacted stage.

## Failure Handling
- Retry policy: 2 retries per node.
- Persistent failure: emit `handoff.md` with unresolved blockers.

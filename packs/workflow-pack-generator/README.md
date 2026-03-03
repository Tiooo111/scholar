# workflow-pack-generator (Meta Workflow Pack)

Generate a runnable Workflow Pack from a user task.

## Purpose
Given a task description, this pack produces:
- aligned requirements (`requirements.md` as SSOT)
- architecture and role design
- executable task plan
- verification + deviation routing
- final reusable workflow pack assets

## Stages
1. Alignment
2. Design
3. Build
4. Verify + Feedback Loop

## Core Principle
`requirements.md` is the single source of truth for all downstream roles.

## Minimal Executor (v0)
Run the pack with the generic runner:

```bash
cd /home/node/.openclaw/workspace-scholar
node engine/wf-runner.js \
  --workflow packs/workflow-pack-generator/workflow.yaml
```

Optional deviation injection test:

```bash
node engine/wf-runner.js \
  --workflow packs/workflow-pack-generator/workflow.yaml \
  --inject-deviation implementation_bug
```

Outputs are written under `.runs/<run-id>/` with:
- `execution_report.json`
- `execution_state.json` (resume checkpoint)
- `execution_events.jsonl` (event timeline)

This pack also includes machine-checkable output contracts in:
- `contracts/contract-rules.yaml`
- `contracts/*.schema.json`

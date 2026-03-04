# MetaPipe (Meta Generator Pipe)

MetaPipe generates a runnable pipe from a user task.

## Purpose
Given a task description, MetaPipe produces:
- aligned requirements (`requirements.md` as SSOT)
- architecture and role design
- executable task plan
- verification + deviation routing
- operational hardening outputs (`risk_register.md`, `slo_targets.md`, `architecture_decisions.md`)
- final reusable pipe assets

## Stages
1. Alignment
2. Design
3. Build
4. Verify
5. Operability Optimization (risk + SLO + ADR)
6. Feedback Loop / Finalize

## Core Principle
`requirements.md` is the single source of truth for all downstream roles.

## Run

```bash
cd /home/node/.openclaw/workspace-scholar
npm run wf:validate -- metapipe
npm run wf:run -- metapipe --dry-run

# recommended real input run
npm run wf:run -- metapipe --input task_prompt="Design an internal incident triage workflow"
```

Optional deviation injection:

```bash
npm run wf:run -- metapipe --inject-deviation implementation_bug --input task_prompt="Design a billing approval workflow"
```

Outputs are written under `.runs/<run-id>/` with:
- `execution_report.json`
- `execution_state.json` (resume checkpoint)
- `execution_events.jsonl` (event timeline)

This pipe includes machine-checkable output contracts in:
- `contracts/contract-rules.yaml`
- `contracts/*.schema.json`

Role-level executor defaults are declared in `roles.yaml` (currently `template`, with optional `script` examples).

Script executor examples:
- `scripts/build_pack.js`
- `scripts/verify_pack.js`

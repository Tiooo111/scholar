# OpenPipe

OpenPipe is a **unified Pipe framework** for:

- multi-agent orchestration
- workflow/state-machine execution
- contract validation + deviation routing
- publishing/integration surfaces (CLI, REST, stdio RPC, MCP)

It includes a built-in meta pipe named **MetaPipe** (`pipes/metapipe`) that generates new pipes for other business tasks.

## Core Layers

1. **Framework Runtime** (`engine/`)
   - runner + policy engine (retry/timeout/backoff)
   - checkpoint/resume
   - contract validation
   - executor plugins (`template`, `shell`, `script`, `llm`)

2. **Pipes** (`pipes/`)
   - `metapipe/` (meta generator pipe)
   - `scholar-radar/` (business example)

3. **Docs** (`docs/`)
   - architecture and structure conventions

---

## Project Structure

```text
OpenPipe/
├─ engine/                 # Runtime and invocation surfaces
├─ pipes/
│  ├─ metapipe/            # Meta pipe: generate new pipes
│  └─ scholar-radar/       # Example business pipe
├─ packs/                  # Reserved for compatibility/legacy
├─ docs/
├─ package.json
└─ README.md
```

> Compatibility note: legacy path `radar/` is kept as a symlink to `pipes/scholar-radar`.

---

## Quick Start

```bash
cd /home/node/.openclaw/workspace-scholar
npm install
```

List workflows:

```bash
npm run wf:list
npm run wf:list -- --details
node engine/wf-cli.js describe metapipe
npm run wf:sync-check -- metapipe
npm run wf:sync-lock -- metapipe   # run after intentional workflow/logic changes
npm run wf:validate -- metapipe
npm run wf:doctor -- metapipe
npm run wf:runs -- --summary-only
npm run wf:runs -- --trends --limit 200
```

Run MetaPipe:

```bash
npm run wf:run -- metapipe --dry-run
# or provide explicit inputs
npm run wf:run -- metapipe --input task_prompt="Design a customer support triage workflow"
```

Scaffold a new pipe starter:

```bash
npm run wf:scaffold -- procurement-flow
npm run wf:validate -- procurement-flow
```

REST call:

```bash
npm run wf:api
curl http://127.0.0.1:8787/workflows/metapipe/sync-check
curl -X POST http://127.0.0.1:8787/workflows/metapipe/sync-lock
curl http://127.0.0.1:8787/workflows/metapipe/validate
curl http://127.0.0.1:8787/workflows/metapipe/doctor?limit=100
curl http://127.0.0.1:8787/runs/summary
curl http://127.0.0.1:8787/runs/trends?limit=200
curl -X POST http://127.0.0.1:8787/workflows/scaffold \
  -H 'content-type: application/json' \
  -d '{"packId":"procurement-flow"}'
curl -X POST http://127.0.0.1:8787/workflows/metapipe/run \
  -H 'content-type: application/json' \
  -d '{"inputs":{"task_prompt":"Design a customer support triage workflow"}}'
```

MCP server:

```bash
npm run wf:mcp
```

---

## Produced Run Artifacts

Each run writes under `.runs/<run-id>/`:

- `execution_report.json`
- `execution_state.json` (checkpoint)
- `execution_events.jsonl` (timeline)
- declared workflow artifacts

---

## Docs

- `docs/ARCHITECTURE.md`
- `docs/PROJECT_STRUCTURE.md`
- `engine/README.md`
- `pipes/metapipe/README.md`

---

## Next Milestones

- Executor registry + versioned plugin API
- Built-in publisher adapters
- Pipe scaffolding command (`wf scaffold <pipe-id>`)

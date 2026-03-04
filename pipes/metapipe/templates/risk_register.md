# risk_register.md

## Top Risks
1. Risk: unclear ownership for critical path nodes
   - Impact: delivery delay or inconsistent outputs
   - Likelihood: medium
2. Risk: insufficient contract coverage for newly added artifacts
   - Impact: silent quality regressions
   - Likelihood: medium

## Mitigations
- Enforce `wf validate` in CI before every run/release.
- Add contract rules whenever new output files are introduced.
- Keep retry/timeout policy explicit per critical node.

## Run Context
- workflowId: {{workflowId}}
- runId: {{runId}}
- quality_target: {{input_quality_target}}

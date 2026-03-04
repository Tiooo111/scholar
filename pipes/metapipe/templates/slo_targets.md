# slo_targets.md

## Service Level Objectives
- Reliability SLO: successful run termination (`terminatedBy=end`) >= 99%
- Correctness SLO: contract-violation rate <= 1%
- Latency SLO: p95 run duration within expected project threshold

## Error Budget Policy
- If SLO violated for 2 consecutive days, freeze feature work and run a hardening sprint.

## Measurement Plan
- Data source: execution_report.json + runs summary/trends endpoints
- Cadence: daily trend review
- Owner: optimizer

## Inputs
- runtime_constraints: {{runtimeConstraints}}
- quality_target: {{input_quality_target}}

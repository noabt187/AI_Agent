# Agent Evaluation Implementation Plan

1. Add `AGENT_EVAL_LOCAL_ONLY` enforcement in `src/tools/index.ts` and cover it with a deterministic unit test.
2. Add shared evaluation types and eight task definitions under `eval/`, with fixture files generated into a fresh per-Trial directory.
3. Add deterministic Outcome, Safety and Trace graders. Keep hidden expectations outside the Agent allowed path.
4. Add a Tool Contract runner that executes local tools with valid and invalid inputs and reports contract, argument, permission and isolation results.
5. Add an Orchestrator-based Trial runner that records Agent events, controls confirmations per task, applies timeouts, loads persisted token/latency metrics and redacts secrets.
6. Add aggregation for pass@1, pass³, hidden-test success, tool selection, argument validity, permission violations, recovery, scope changes and efficiency.
7. Add JSONL, JSON and Markdown report writers and expose `eval:tools`, `eval:smoke` and `eval` npm commands through `scripts/run-eval.ts`.
8. Run existing tests and TypeScript builds, then run Tool Contract Eval.
9. Run one paid Smoke Trial. Stop on model/configuration failure; otherwise run the eight-task first round and then the remaining two rounds.
10. Review failed traces, verify metric denominators and write a resume-safe result based only on completed Trials.

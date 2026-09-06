# DSH Experiment Metrics

A local-first DeepSeek Harness plugin for paired A/B experiments. It compares a normal frontend workflow (Control) with the PageCraft DOM-feedback workflow using DSH's real `tokenUsage` projection.

## What it measures

- Actual uncached input, cache-read, cache-write, and output tokens
- Token delta between an experiment's start and end snapshots
- Task pass/fail, interaction turns, clarifications, and rework count
- Per-pair token saving and median saving rate across completed pairs
- JSON and CSV exports for later analysis

The plugin only calculates a saving rate when both arms pass the same acceptance criteria. A failed arm is reported, but it is never presented as a token saving.

## Install from local source

Build the plugin:

```powershell
cd <你的插件目录，例如 ./plugins/dsh-experiment-metrics>
npm install
npm run check
```

Add it to the DSH web profile from your DeepSeek Harness source directory:

```powershell
cd <你的 DeepSeek Harness 源码目录，例如 ./deepseek-harness>
pnpm dsh plugin --profile web add <你的 dsh-experiment-metrics 本地路径>
pnpm dsh --profile web
```

After DSH starts, open a conversation and choose **实验对比**.

## Recommended experiment workflow

1. Freeze one task, one acceptance checklist, one model/configuration, and one Git base commit.
2. Create two independent Git worktrees from that commit.
3. Open one DSH session for Control and another for PageCraft.
4. Create an experiment in **实验对比** and bind the two session IDs.
5. Record the start snapshot for both arms before sending the task.
6. Control completes the task without PageCraft; the experiment arm uses PageCraft annotations.
7. Apply the same acceptance checklist, record pass/fail and manual process counts, then record both end snapshots.
8. Export the dataset after several different real tasks. Prefer the median saving rate over a single impressive result.

Do not run a synthetic benchmark just to create data. Each real frontend task can become one pair: perform it once through each workflow in isolated worktrees and keep both results.

## Metric definition

For each token bucket:

```text
experiment usage = end snapshot - start snapshot
processed input = uncached input + cache read + cache write
total tokens = processed input + output
saving rate = (Control total - PageCraft total) / Control total
```

If DSH has not produced a `tokenUsage` value, run the model in that session once and confirm the built-in token-meter plugin is enabled.

## Privacy

Experiment records live in browser `localStorage`. The plugin stores session IDs, token snapshots, task metadata, outcome fields, and notes. It does not collect preview HTML, DOM selections, prompts, or repository files. Export files are created only when the user clicks an export button.

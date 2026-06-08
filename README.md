# Dashboard Builder — the agent

A [Strands Agents](https://github.com/strands-agents) agent (running on Amazon Bedrock
Claude) that turns **mockup dashboards** into a **real, offline dashboard**. It studies
your Word/PDF mockups, designs a data model, emits a fillable Excel template, generates
the dashboard, and iterates with you until it matches.

The agent runs on *your* machine (needs Python + AWS). What it produces — the dashboard —
needs neither: the end user just opens `index.html`.

**This folder is self-contained.** It bundles the dashboard engine in `template/` and a
sample workbook in `sample/`, so you can copy just `agent/` to another machine and run it —
no dependency on the rest of the repo. (`template/` is a copy of `../renderer`; if you change
the engine in `renderer/`, re-copy it into `template/`.)

## How the pieces fit

```
mockups (.docx/.pdf)
      │
      ▼
  [ agent ]  ── reads images (vision) ──► designs a SPEC (JSON)
      │                                         │
      ├── create_excel_template(spec) ──► out/session/template.xlsx   (user fills this)
      │                                         │
      └── build_dashboard(spec, data) ──► out/session/dashboard/      (the deliverable)
                                                │
                                          uses template/ (the bundled engine)
```

- `generator.py` — deterministic, no LLM. Builds the dashboard folder (by reusing the
  verified `renderer/` engine and swapping in `spec.js` + `data.js`) and the Excel template.
- `mockups.py` — extracts images from Word/PDF for the model to see.
- `tools.py` — the three Strands tools: `create_excel_template`, `build_dashboard`,
  `inspect_workbook`.
- `system_prompt.md` — teaches the model the spec format.
- `examples/resource_allocation.spec.json` — the canonical reference spec (also spec #1).
- `main.py` — the CLI: extract mockups → first agent turn with images → iterate.

## Setup

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt        # versions are pinned to what was verified
aws configure        # or: aws sso login / export AWS_PROFILE=<name>
# enable your Claude model in the Bedrock console → Model access
```

## Run

```bash
python main.py --mockups "../Resource Allocation Dashboard Concept_DRAFT_25May2026_Claude.docx" \
               --region us-east-1 \
               --model us.anthropic.claude-sonnet-4-6 \
               --profile my-sso-profile        # named AWS profile (optional)
```

`--profile` selects a named profile from `~/.aws/config` (e.g. an SSO profile) — handy at
work. Omit it to use the default credential chain or the `AWS_PROFILE` env var. With SSO,
run `aws sso login --profile my-sso-profile` first.

Always pass `--model` (an enabled Bedrock model id or inference-profile id) and `--region`
explicitly — the built-in defaults may not be enabled in your account. List what you have:

```bash
aws bedrock list-inference-profiles --region <region> \
  --query "inferenceProfileSummaries[?contains(inferenceProfileId,'claude')].inferenceProfileId" --output table
```

Then converse: it builds a preview immediately, you fill `out/session/template.xlsx`, tell
it the path, and it rebuilds with your data. Give feedback ("add a demand view", "make the
trend monthly") and it revises. Open `out/session/dashboard/index.html` any time.

### Rehearse without Bedrock — `--dry-run`

```bash
python main.py --mockups "../Resource Allocation Dashboard Concept_DRAFT_25May2026_Claude.docx" \
               --out out/dryrun --dry-run
```

Runs the **entire flow with no LLM call**: extracts your mockups, uses the reference spec as
a stand-in for what Claude would design, and calls the real tools — so you get an actual
template and dashboard, and can paste a filled `.xlsx` path to rebuild with real data. The
only thing it skips is Claude designing/revising the spec.

## Sample data

`sample/resource_allocation_sample.xlsx` is a **fully-worked example** (8 people, 5 assets,
all 12 months across 2024–2025, with a Demand sheet). Open it to see the expected shape, and
**copy your real data into it**. Key rule it demonstrates: an FTE is a person's allocation
*averaged over every month in the Calendar sheet*, so give each person a row for **every
month they work** — 100% across all 12 months = 1.0 FTE (100% in only 1 month = 0.08 FTE).

## Testing the deterministic core (no AWS needed)

```bash
python generator.py examples/resource_allocation.spec.json \
    sample/resource_allocation_sample.xlsx out/resource_allocation
# → builds a full dashboard + template you can open immediately
```

## Running at work / in a corporate AWS account

- **Region must match the model profile.** `us.anthropic.…` profiles only work in US
  regions; for eu/apac use the matching `eu.`/`apac.` profile and `--region`.
- **Model access** must be enabled in *that* account (Bedrock → Model access) — a personal
  account having the model says nothing about the work one.
- **Credentials** are usually SSO at work: `aws sso login`, and likely `export AWS_PROFILE=…`.
- **IAM/guardrails:** you need `bedrock:InvokeModel` on the profile and underlying models. A
  403 on first invoke is permissions/SCP, not the code.
- **What leaves the machine:** the mockup images, sheet/column **headers** (via
  `inspect_workbook`), and anything you type go to Bedrock. The **actual cell values** of your
  Excel do **not** — they're embedded into the dashboard locally. The generated dashboard
  never leaves the machine. Confirm this is acceptable under your data policy.
- **Locked-down pip:** PyPI may be blocked; you may need an internal mirror. If you only use
  `.docx` mockups, `pymupdf` is optional (it's only for PDFs).
- **Rehearse first** with `--dry-run` (no AWS) to confirm paths and the pipeline.

## Scaling to bespoke dashboards later

Today the agent picks from the renderer's supported section types (the "adapt a proven
template" approach). To handle arbitrary dashboards later, add a new section type to
`renderer/engine.js`'s `SECTION` registry and document it in `system_prompt.md` — the
agent loop, tools, and Excel pipeline stay unchanged.

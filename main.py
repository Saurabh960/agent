"""
main.py — the Strands Dashboard Builder agent.

Reads mockup dashboards (Word/PDF), designs a data model + Excel template, and
generates a self-contained offline dashboard, iterating with you in the terminal.

Usage:
    python main.py --mockups path/to/mockups.docx
    python main.py --mockups deck.pdf --out out/my_project --region us-east-1 \
                   --model us.anthropic.claude-sonnet-4-20250514-v1:0

Requires AWS credentials with Bedrock access to the chosen Claude model.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import mockups  # noqa: E402
import tools  # noqa: E402


def build_agent(model_id: str, region: str, profile: str | None = None):
    from strands import Agent
    from strands.models import BedrockModel

    system_prompt = (HERE / "system_prompt.md").read_text(encoding="utf-8")
    if profile:
        import boto3
        session = boto3.Session(profile_name=profile, region_name=region)
        model = BedrockModel(model_id=model_id, boto_session=session)
    else:
        model = BedrockModel(model_id=model_id, region_name=region)
    return Agent(
        model=model,
        system_prompt=system_prompt,
        tools=[tools.create_excel_template, tools.build_dashboard, tools.inspect_workbook],
    )


def run_dry(mockup_paths: list[str], spec_json: str) -> None:
    """Rehearse the full flow with no LLM: use the reference spec as a stand-in
    for what Claude would design, and run the real tools so the user sees real output."""
    print("\n=== DRY RUN — no Bedrock ===")
    print(f"In a real run, Claude would study your {len(mockup_paths)} mockup(s) and design")
    print("a spec. Here we use the reference resource-allocation spec as a stand-in, and run")
    print("the exact tools the agent would call.\n")

    print("[agent → create_excel_template]")
    print("  " + tools.create_excel_template(spec_json) + "\n")
    print("[agent → build_dashboard]  (placeholder preview data)")
    print("  " + tools.build_dashboard(spec_json) + "\n")

    print("Now: fill the template above, then paste its path here to rebuild with real data.")
    print("Anything else is treated as feedback (a real run would revise the spec via Claude).")
    print("Type 'exit' to quit.\n")
    last_data = ""  # remember the most recent dataset so feedback rebuilds keep it
    while True:
        try:
            msg = input("you > ").strip().strip('"').strip("'")
        except (EOFError, KeyboardInterrupt):
            print()
            break
        if msg.lower() in {"exit", "quit", "q"}:
            break
        if not msg:
            continue
        if msg.lower().endswith((".xlsx", ".xls")):
            last_data = msg
            print("\n[agent → inspect_workbook]")
            print("  " + tools.inspect_workbook(msg).replace("\n", "\n  "))
            print("[agent → build_dashboard]  (your real data)")
            print("  " + tools.build_dashboard(spec_json, msg) + "\n")
        else:
            print("  (dry run) Noted: \"" + msg + "\". Revising the spec from feedback needs")
            print("  Bedrock; rebuilding with the current spec" +
                  (" and your data." if last_data else " and placeholder data."))
            print("  " + tools.build_dashboard(spec_json, last_data) + "\n")


def main() -> None:
    ap = argparse.ArgumentParser(description="Strands Dashboard Builder")
    ap.add_argument("--mockups", required=True, help="Word/PDF/image of the target dashboards")
    ap.add_argument("--out", default="out/session", help="output directory for template + dashboard")
    ap.add_argument("--region", default="us-east-1", help="AWS region for Bedrock")
    ap.add_argument("--profile", default=None,
                    help="named AWS profile (e.g. an SSO profile from ~/.aws/config). "
                         "If omitted, uses the default credential chain / AWS_PROFILE env var.")
    ap.add_argument(
        "--model",
        default="us.anthropic.claude-sonnet-4-20250514-v1:0",
        help="Bedrock model id (must be enabled in your account)",
    )
    ap.add_argument(
        "--dry-run", action="store_true",
        help="rehearse the full flow with NO Bedrock call: uses the reference spec as a "
             "stand-in for what Claude would design, and runs the real tools.",
    )
    args = ap.parse_args()

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    tools.OUT_DIR = out_dir  # bind tools to this session's output folder

    # 1. extract mockup images so the model can see them
    img_dir = out_dir / "mockups"
    paths = mockups.extract_images(args.mockups, img_dir)
    print(f"Extracted {len(paths)} mockup image(s) from {args.mockups} -> {img_dir}")
    image_blocks = mockups.load_image_blocks(paths)

    # reference example spec, shown to the model as the canonical format
    example = (HERE / "examples" / "resource_allocation.spec.json").read_text(encoding="utf-8")

    # ---- dry run: rehearse the whole flow without Bedrock ----
    if args.dry_run:
        run_dry(paths, example)
        return

    agent = build_agent(args.model, args.region, args.profile)

    # 2. first turn: instructions + the mockup images + the reference spec
    intro = [
        {"text":
            "Here are the dashboard mockups to reproduce. Study them, design a data "
            "model, produce a spec in the documented format, then call "
            "create_excel_template and build_dashboard. Below is a complete reference "
            "spec (resource allocation) — mirror its structure:\n\n"
            "```json\n" + example + "\n```"},
        *image_blocks,
    ]
    print("\n--- Agent ---")
    result = agent(intro)
    print(result)

    # 3. interactive iteration loop
    print("\nType feedback to iterate (e.g. 'make the trend monthly', or "
          "'data is ready at out/session/template.xlsx'). Type 'exit' to quit.\n")
    while True:
        try:
            msg = input("you > ").strip()
        except (EOFError, KeyboardInterrupt):
            print()
            break
        if msg.lower() in {"exit", "quit", "q"}:
            break
        if not msg:
            continue
        print("\n--- Agent ---")
        print(agent(msg))
        print()


if __name__ == "__main__":
    main()

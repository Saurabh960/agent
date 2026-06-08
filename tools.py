"""
tools.py — the Strands @tool functions the agent calls.

Thin wrappers over generator.py (which is plain, tested Python). The agent
designs a *spec* and uses these to materialize the Excel template and the
self-contained dashboard, and to inspect filled workbooks while iterating.
"""
from __future__ import annotations

import json
from pathlib import Path

from strands import tool

import generator

# the per-session output directory; main.py sets this before building the agent
OUT_DIR = Path("out/session")


def _parse(spec_json: str) -> dict:
    spec = json.loads(spec_json) if isinstance(spec_json, str) else spec_json
    if "sections" not in spec or "model" not in spec:
        raise ValueError("Spec must include at least 'model' and 'sections'.")
    return spec


def _synthesize_sample(spec: dict) -> dict:
    """Build a tiny non-empty dataset from the dataModel column examples,
    so a freshly generated dashboard previews with placeholder data."""
    data: dict[str, list[dict]] = {}
    for sh in (spec.get("dataModel") or {}).get("sheets", []):
        cols = sh.get("columns", [])
        rows = []
        for _ in range(3):
            rows.append({c["name"]: c.get("example", "") for c in cols})
        data[sh["name"]] = rows
    return data


@tool
def create_excel_template(spec_json: str) -> str:
    """Write the fillable Excel data template for a dashboard spec.

    Args:
        spec_json: the full dashboard spec as a JSON string. Must contain a
            'dataModel' with 'sheets' (each sheet has name, description, columns).

    Returns a short status message with the saved template path and its sheets.
    """
    spec = _parse(spec_json)
    path = generator.write_excel_template(spec, OUT_DIR / "template.xlsx")
    sheets = [s["name"] for s in spec["dataModel"]["sheets"]]
    return f"Template written to {path}. Sheets: {', '.join(sheets)}. Ask the user to fill it and tell you the path."


@tool
def build_dashboard(spec_json: str, data_xlsx_path: str = "") -> str:
    """Generate the self-contained, offline dashboard from a spec.

    Args:
        spec_json: the full dashboard spec as a JSON string.
        data_xlsx_path: optional path to a filled .xlsx. If omitted, the
            dashboard is built with small placeholder data so it still previews.

    Returns the folder path. The user opens index.html there (no internet/Python).
    """
    spec = _parse(spec_json)
    if data_xlsx_path:
        data = generator.read_workbook(data_xlsx_path)
    else:
        data = _synthesize_sample(spec)
    folder = generator.generate_dashboard(spec, data, OUT_DIR / "dashboard")
    n = sum(len(v) for v in data.values())
    src = data_xlsx_path or "placeholder sample"
    return (f"Dashboard generated at {folder} (data: {src}, {n} rows). "
            f"Open {folder}/index.html in a browser — works offline.")


@tool
def inspect_workbook(path: str) -> str:
    """Read a filled .xlsx and report each sheet's row count and column headers.

    Use this to validate the data the user filled before (re)building the dashboard.
    """
    data = generator.read_workbook(path)
    lines = []
    for sheet, rows in data.items():
        headers = list(rows[0].keys()) if rows else []
        lines.append(f"{sheet}: {len(rows)} rows; columns = {headers}")
    return "\n".join(lines) if lines else "No data sheets found."

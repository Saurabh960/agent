"""
mockups.py — pull images out of the mockup document the user provides.

Supports Word (.docx) and PDF. The extracted PNGs are handed to the agent's
(vision-capable) model so it can "see" the dashboards it must reproduce.
"""
from __future__ import annotations

import zipfile
from pathlib import Path


def extract_images(path: str | Path, out_dir: str | Path) -> list[str]:
    """Extract mockup images from a .docx or .pdf into out_dir. Returns PNG/img paths."""
    src = Path(path)
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    ext = src.suffix.lower()
    if ext == ".docx":
        return _from_docx(src, out)
    if ext == ".pdf":
        return _from_pdf(src, out)
    if ext in (".png", ".jpg", ".jpeg", ".webp"):
        dst = out / src.name
        dst.write_bytes(src.read_bytes())
        return [str(dst)]
    raise ValueError(f"Unsupported mockup type: {ext}. Use .docx, .pdf, or an image.")


def _from_docx(src: Path, out: Path) -> list[str]:
    """Word stores embedded images under word/media/ inside the zip."""
    paths: list[str] = []
    with zipfile.ZipFile(src) as z:
        media = sorted(n for n in z.namelist() if n.startswith("word/media/"))
        for i, name in enumerate(media, start=1):
            ext = Path(name).suffix or ".png"
            dst = out / f"mockup_{i}{ext}"
            dst.write_bytes(z.read(name))
            paths.append(str(dst))
    if not paths:
        raise ValueError(f"No embedded images found in {src.name}.")
    return paths


def _from_pdf(src: Path, out: Path) -> list[str]:
    """Render each PDF page to a PNG (captures layout, not just embedded images)."""
    try:
        import fitz  # PyMuPDF
    except ImportError as e:
        raise ImportError(
            "Reading PDF mockups needs PyMuPDF. Install it: pip install pymupdf"
        ) from e
    paths: list[str] = []
    doc = fitz.open(src)
    for i, page in enumerate(doc, start=1):
        pix = page.get_pixmap(dpi=150)
        dst = out / f"mockup_page{i}.png"
        pix.save(dst)
        paths.append(str(dst))
    doc.close()
    if not paths:
        raise ValueError(f"No pages rendered from {src.name}.")
    return paths


def load_image_blocks(paths: list[str]) -> list[dict]:
    """Turn image paths into Bedrock/Strands content blocks for the model to see."""
    blocks: list[dict] = []
    for p in paths:
        fmt = Path(p).suffix.lower().lstrip(".")
        if fmt == "jpg":
            fmt = "jpeg"
        if fmt not in ("png", "jpeg", "gif", "webp"):
            continue
        blocks.append({"image": {"format": fmt, "source": {"bytes": Path(p).read_bytes()}}})
    return blocks

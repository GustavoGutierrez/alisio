"""Declare published outputs explicitly (optional ``outputs.json``)."""

import json
from pathlib import Path
from typing import Optional

from . import output_dir


def path(name: str) -> Path:
    """Absolute path for a new output file, creating parent folders."""
    target = output_dir() / name
    target.parent.mkdir(parents=True, exist_ok=True)
    return target


def declare(name: str, title: Optional[str] = None, entry: Optional[str] = None) -> None:
    """Adds an artifact to outputs.json. Once the file exists, ONLY declared outputs are published."""
    manifest_path = output_dir() / "outputs.json"
    manifest = {"artifacts": []}
    if manifest_path.exists():
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    item = {"path": name}
    if title:
        item["title"] = title
    if entry:
        item["entry"] = entry
    manifest["artifacts"] = [a for a in manifest.get("artifacts", []) if a.get("path") != name]
    manifest["artifacts"].append(item)
    manifest_path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")

"""Helpers for scripts run by Alisio's python_run tool (standard library only).

Everything a script writes to ``output_dir()`` ($ALISIO_OUTPUT_DIR) is published as a
downloadable artifact when the script exits with code 0. Intermediate files belong in
``work_dir()`` (the current directory), never in the output folder.
"""

import os
from pathlib import Path

__all__ = ["output_dir", "input_dir", "work_dir", "execution_id", "outputs", "html", "svg", "datasets"]
__version__ = "1"


def _dir(name: str, fallback: str) -> Path:
    return Path(os.environ.get(name) or fallback)


def output_dir() -> Path:
    """Folder whose files are published as artifacts ($ALISIO_OUTPUT_DIR)."""
    return _dir("ALISIO_OUTPUT_DIR", "out")


def input_dir() -> Path:
    """Read-only copies of the inputs given to python_run ($ALISIO_INPUT_DIR)."""
    return _dir("ALISIO_INPUT_DIR", "input")


def work_dir() -> Path:
    """Scratch folder for intermediate files; also the current directory."""
    return _dir("ALISIO_WORK_DIR", ".")


def execution_id() -> str:
    return os.environ.get("ALISIO_EXECUTION_ID", "")

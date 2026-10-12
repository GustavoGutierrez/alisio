"""Talk to Alisio's Forja core from a python_run script (standard library only).

    from alisio_runtime import forge

    forge.progress("Training model", completed=1, total=3)
    forge.text({"rows": 1200, "accuracy": 0.91})   # explicit output for the model
    forge.result({"best_params": {"depth": 4}})    # final value, sent when the script exits
    last = forge.state.get("last_dataset")         # snapshot taken when the run started
    forge.state.set("last_dataset", "ds_123")      # kept only if the whole run succeeds

Messages travel as marked lines on stdout (``\\x1eALISIO-FORGE:<nonce>:<json>``), so a frame must
start a line: end a half-written line with ``print()`` before calling these functions. Values must
be JSON (no NaN or Infinity); a message over 256 KiB is refused here instead of ending the run.
The nonce only tells frames from ordinary output. The functions never call tools or run code.

Outside Alisio (no ``ALISIO_FORGE_NONCE`` in the environment) every function degrades to a plain
``print`` and ``state`` keeps its values in memory only.
"""

import atexit
import json
import os
import sys

__all__ = ["progress", "text", "result", "state"]

_MAX_MESSAGE_BYTES = 256 * 1024
_CHUNK = 32 * 1024

_seq = 0
_ready = False
_exit_registered = False
_result = []  # [value] once forge.result() was called


def _nonce():
    return os.environ.get("ALISIO_FORGE_NONCE") or None


def _send(kind, payload):
    global _seq
    message = json.dumps(
        {"protocol": 1, "type": kind, "seq": _seq, "payload": payload},
        ensure_ascii=False,
        separators=(",", ":"),
        allow_nan=False,
    )
    if len(message.encode("utf-8")) > _MAX_MESSAGE_BYTES:
        raise ValueError("forge message is larger than %d bytes" % _MAX_MESSAGE_BYTES)
    _seq += 1
    sys.stdout.write("\x1eALISIO-FORGE:%s:%s\n" % (_nonce(), message))
    sys.stdout.flush()


def _hello():
    global _ready
    if not _ready:
        _ready = True
        _send(
            "ready",
            {"engine": os.environ.get("ALISIO_FORGE_ENGINE") or "python-managed", "preludeHash": "forge.py@4"},
        )


def _emit(kind, payload):
    _hello()
    _send(kind, payload)


def progress(message, completed=None, total=None):
    """Report progress; the UI shows the newest message (at most four updates per second)."""
    if _nonce() is None:
        suffix = "" if completed is None or total is None else " (%s/%s)" % (completed, total)
        print("%s%s" % (message, suffix))
        return
    payload = {"message": str(message)}
    if completed is not None:
        payload["completed"] = completed
    if total is not None:
        payload["total"] = total
    _emit("progress", payload)


def text(value):
    """Send explicit output to the model: a string as it is, anything else as JSON."""
    out = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False)
    if _nonce() is None:
        print(out)
        return
    for at in range(0, max(len(out), 1), _CHUNK):
        _emit("output", {"type": "text", "text": out[at : at + _CHUNK]})


def _complete():
    if _result and _nonce() is not None:
        _emit("complete", {"value": _result[0]})


def result(value):
    """Set the final value of the run (``ForgeResult.value``); it is sent when the script exits."""
    global _exit_registered
    if _nonce() is None:
        print(json.dumps(value, ensure_ascii=False))
        return
    json.dumps(value, allow_nan=False)  # fail here, in the caller's frame, if it is not JSON
    _result[:] = [value]
    if not _exit_registered:
        _exit_registered = True
        atexit.register(_complete)


class _State:
    """Values shared with later executions, JavaScript ones included (same store)."""

    def __init__(self):
        self._values = None

    def _load(self):
        if self._values is None:
            self._values = {}
            work = os.environ.get("ALISIO_WORK_DIR") or "."
            try:
                with open(os.path.join(work, ".forge", "state.json"), encoding="utf-8") as handle:
                    loaded = json.load(handle)
                if isinstance(loaded, dict):
                    self._values = loaded
            except (OSError, ValueError):
                pass
        return self._values

    def get(self, key, default=None):
        return self._load().get(key, default)

    def set(self, key, value):
        json.dumps(value, allow_nan=False)
        values = self._load()
        if _nonce() is not None:
            _emit("state.set", {"key": str(key), "value": value})
        values[str(key)] = value

    def delete(self, key):
        values = self._load()
        if _nonce() is not None:
            _emit("state.delete", {"key": str(key)})
        values.pop(str(key), None)


state = _State()

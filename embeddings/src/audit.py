from __future__ import annotations

import json
import os
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, Optional


class AuditLogger:
    def __init__(self, audit_dir: str) -> None:
        Path(audit_dir).mkdir(parents=True, exist_ok=True)
        stamp = time.strftime("%Y-%m-%dT%H-%M-%S", time.gmtime())
        self._path = Path(audit_dir) / f"embeddings-audit-{stamp}.jsonl"

    def log(self, ev: Dict[str, Any]) -> None:
        ev = dict(ev)
        ev.setdefault("t", int(time.time() * 1000))
        with self._path.open("a", encoding="utf-8") as f:
            f.write(json.dumps(ev, ensure_ascii=False) + "\n")


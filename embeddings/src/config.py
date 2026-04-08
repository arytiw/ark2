from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict


@dataclass(frozen=True)
class EmbeddingsConfig:
    host: str
    port: int
    auditLogDir: str
    indexDir: str
    backend: str  # mock | llamacpp
    dim: int
    maxTextBytes: int
    maxBatch: int
    llamaBinPath: str
    modelPath: str


def _req_str(v: Any, name: str) -> str:
    if not isinstance(v, str) or len(v) == 0:
        raise ValueError(f"{name} must be non-empty string")
    return v


def _req_int(v: Any, name: str, mn: int, mx: int) -> int:
    if not isinstance(v, int) or v < mn or v > mx:
        raise ValueError(f"{name} must be int in [{mn}, {mx}]")
    return v


def load_config(project_root: str) -> EmbeddingsConfig:
    raw = json.loads(Path(project_root, "config.json").read_text(encoding="utf-8"))
    if not isinstance(raw, dict):
        raise ValueError("config.json must be object")
    e = raw.get("embeddings")
    if not isinstance(e, dict):
        raise ValueError("config.embeddings must be object")
    host = _req_str(e.get("host"), "embeddings.host")
    port = _req_int(e.get("port"), "embeddings.port", 1, 65535)
    audit_dir = _req_str(e.get("auditLogDir"), "embeddings.auditLogDir")
    index_dir = _req_str(e.get("indexDir"), "embeddings.indexDir")
    backend = _req_str(e.get("backend"), "embeddings.backend")
    if backend not in ("mock", "llamacpp"):
        raise ValueError("embeddings.backend must be mock|llamacpp")
    dim = _req_int(e.get("dim"), "embeddings.dim", 8, 4096)
    max_text_bytes = _req_int(e.get("maxTextBytes"), "embeddings.maxTextBytes", 1, 10 * 1024 * 1024)
    max_batch = _req_int(e.get("maxBatch"), "embeddings.maxBatch", 1, 2048)
    llama_bin = _req_str(e.get("llamaBinPath"), "embeddings.llamaBinPath")
    model_path = _req_str(e.get("modelPath"), "embeddings.modelPath")

    pr = Path(project_root)
    return EmbeddingsConfig(
        host=host,
        port=port,
        auditLogDir=str((pr / audit_dir).resolve()),
        indexDir=str((pr / index_dir).resolve()),
        backend=backend,
        dim=dim,
        maxTextBytes=max_text_bytes,
        maxBatch=max_batch,
        llamaBinPath=str((pr / llama_bin).resolve()) if not Path(llama_bin).is_absolute() else llama_bin,
        modelPath=str((pr / model_path).resolve()) if not Path(model_path).is_absolute() else model_path,
    )


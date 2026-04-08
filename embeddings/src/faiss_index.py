from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import faiss  # type: ignore
import numpy as np


@dataclass
class StoredItem:
    id: str
    meta: Dict[str, Any]


class FaissStore:
    def __init__(self, index_dir: str, dim: int) -> None:
        self._dir = Path(index_dir)
        self._dir.mkdir(parents=True, exist_ok=True)
        self._dim = dim
        self._index_path = self._dir / "vectors.faiss"
        self._meta_path = self._dir / "meta.jsonl"

        self._items: List[StoredItem] = []
        self._index = self._load_or_create()

    def _load_or_create(self) -> faiss.Index:
        if self._meta_path.exists():
            self._items = []
            for line in self._meta_path.read_text(encoding="utf-8").splitlines():
                if not line:
                    continue
                obj = json.loads(line)
                self._items.append(StoredItem(id=obj["id"], meta=obj["meta"]))
        if self._index_path.exists():
            idx = faiss.read_index(str(self._index_path))
            if idx.d != self._dim:
                raise ValueError("FAISS index dim mismatch with config")
            return idx
        # Cosine similarity via inner product on normalized vectors.
        return faiss.IndexFlatIP(self._dim)

    @property
    def dim(self) -> int:
        return self._dim

    @property
    def size(self) -> int:
        return len(self._items)

    def upsert_append(self, ids: List[str], metas: List[Dict[str, Any]], vectors: List[List[float]]) -> None:
        # Phase 6: append-only for auditability/determinism; no in-place delete.
        if len(ids) != len(vectors) or len(ids) != len(metas):
            raise ValueError("length mismatch")
        arr = np.asarray(vectors, dtype="float32")
        if arr.ndim != 2 or arr.shape[1] != self._dim:
            raise ValueError("bad vector shape")
        # Normalize for IP cosine.
        faiss.normalize_L2(arr)
        self._index.add(arr)
        for i in range(len(ids)):
            self._items.append(StoredItem(id=ids[i], meta=metas[i]))
        # Persist metadata append-only.
        with self._meta_path.open("a", encoding="utf-8") as f:
            for i in range(len(ids)):
                f.write(json.dumps({"id": ids[i], "meta": metas[i]}, ensure_ascii=False) + "\n")
        faiss.write_index(self._index, str(self._index_path))

    def query(self, vector: List[float], topk: int) -> List[Dict[str, Any]]:
        if self.size == 0:
            return []
        arr = np.asarray([vector], dtype="float32")
        if arr.shape[1] != self._dim:
            raise ValueError("dim mismatch")
        faiss.normalize_L2(arr)
        # Overfetch and de-duplicate by chunk id (append-only indexing may contain older duplicates).
        fetch_k = min(max(topk * 4, topk), max(1, self.size))
        scores, idxs = self._index.search(arr, fetch_k)
        res: List[Dict[str, Any]] = []
        seen: set[str] = set()
        for j in range(fetch_k):
            i = int(idxs[0, j])
            if i < 0 or i >= len(self._items):
                continue
            it = self._items[i]
            if it.id in seen:
                continue
            seen.add(it.id)
            res.append({"id": it.id, "score": float(scores[0, j]), "meta": it.meta})
            if len(res) >= topk:
                break
        return res


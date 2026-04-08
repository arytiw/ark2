from __future__ import annotations

import hashlib
import math
import os
import struct
import subprocess
from dataclasses import dataclass
from typing import List


class Embedder:
    def embed(self, texts: List[str]) -> List[List[float]]:
        raise NotImplementedError


@dataclass(frozen=True)
class MockEmbedder(Embedder):
    dim: int

    def embed(self, texts: List[str]) -> List[List[float]]:
        # Deterministic pseudo-embedding: hash text -> float vector in [-1,1], L2-normalized.
        out: List[List[float]] = []
        for t in texts:
            h = hashlib.sha256(t.encode("utf-8")).digest()
            # Expand hash deterministically by chaining.
            buf = bytearray()
            cur = h
            while len(buf) < self.dim * 4:
                cur = hashlib.sha256(cur).digest()
                buf.extend(cur)
            vec = []
            for i in range(self.dim):
                # 32-bit unsigned -> float in [-1,1]
                u = struct.unpack_from("<I", buf, i * 4)[0]
                x = (u / 0xFFFFFFFF) * 2.0 - 1.0
                vec.append(float(x))
            # Normalize
            norm = math.sqrt(sum(x * x for x in vec)) or 1.0
            out.append([x / norm for x in vec])
        return out


@dataclass(frozen=True)
class LlamaCppEmbedder(Embedder):
    dim: int
    llama_bin_path: str
    model_path: str

    def embed(self, texts: List[str]) -> List[List[float]]:
        # Conservative stub: llama.cpp embedding integration varies by build artifact and flags.
        # We fail closed rather than attempting unknown flags.
        raise RuntimeError(
            "llamacpp embeddings backend not enabled in Phase 6 default build. "
            "Set embeddings.backend='mock' or implement a fixed llama.cpp embedding binary contract."
        )


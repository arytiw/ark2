from __future__ import annotations

import asyncio
import json
import os
import time
from dataclasses import asdict
from typing import Any, Dict, Optional

import websockets
from websockets.server import WebSocketServerProtocol

from .audit import AuditLogger
from .config import load_config
from .embedder import LlamaCppEmbedder, MockEmbedder
from .faiss_index import FaissStore
from .protocol import ServerMsg, validate_client_msg


VERSION = "0.1.0"


def now_ms() -> int:
    return int(time.time() * 1000)


def safe_send(ws: WebSocketServerProtocol, msg: ServerMsg) -> None:
    asyncio.create_task(ws.send(json.dumps(msg, ensure_ascii=False)))


async def main() -> None:
    project_root = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
    cfg = load_config(project_root)
    audit = AuditLogger(cfg.auditLogDir)
    store = FaissStore(cfg.indexDir, cfg.dim)
    embedder = MockEmbedder(cfg.dim) if cfg.backend == "mock" else LlamaCppEmbedder(cfg.dim, cfg.llamaBinPath, cfg.modelPath)

    audit.log({"kind": "server_start", "host": cfg.host, "port": cfg.port, "backend": cfg.backend, "dim": cfg.dim})

    async def handler(ws: WebSocketServerProtocol) -> None:
        client_id = os.urandom(12).hex()
        audit.log({"kind": "client_connect", "clientId": client_id})
        await ws.send(json.dumps({"type": "ready", "version": VERSION}, ensure_ascii=False))
        try:
            async for raw in ws:
                started = now_ms()
                req_id: Optional[str] = None
                try:
                    parsed = json.loads(raw)
                except Exception:
                    audit.log({"kind": "security_violation", "clientId": client_id, "message": "Invalid JSON"})
                    await ws.send(json.dumps({"type": "error", "requestId": None, "error": {"code": "E_BAD_JSON", "message": "Invalid JSON."}}))
                    continue

                msg, err = validate_client_msg(parsed, max_batch=cfg.maxBatch, max_text_bytes=cfg.maxTextBytes)
                if err is not None:
                    req_id = parsed.get("requestId") if isinstance(parsed, dict) else None
                    audit.log({"kind": "security_violation", "clientId": client_id, "requestId": req_id, "message": f"{err['code']}: {err['message']}"})
                    await ws.send(json.dumps({"type": "result", "requestId": req_id or "?", "ok": False, "error": err}, ensure_ascii=False))
                    continue

                assert msg is not None
                req_id = msg["requestId"]
                audit.log({"kind": "request", "clientId": client_id, "requestId": req_id, "type": msg["type"]})

                try:
                    if msg["type"] == "embed":
                        vecs = embedder.embed(msg["texts"])
                        out: Dict[str, Any] = {"vectors": vecs, "dim": cfg.dim}
                        await ws.send(json.dumps({"type": "result", "requestId": req_id, "ok": True, "result": out}, ensure_ascii=False))
                    elif msg["type"] == "upsert":
                        items = msg["items"]
                        texts = [it["text"] for it in items]
                        ids = [it["id"] for it in items]
                        metas = [it["meta"] for it in items]
                        vecs = embedder.embed(texts)
                        store.upsert_append(ids, metas, vecs)
                        await ws.send(json.dumps({"type": "result", "requestId": req_id, "ok": True, "result": {"added": len(ids), "size": store.size}}, ensure_ascii=False))
                    else:
                        # query
                        vec = embedder.embed([msg["text"]])[0]
                        matches = store.query(vec, int(msg["topK"]))
                        await ws.send(json.dumps({"type": "result", "requestId": req_id, "ok": True, "result": {"matches": matches, "size": store.size}}, ensure_ascii=False))

                    audit.log({"kind": "result", "clientId": client_id, "requestId": req_id, "ok": True, "elapsedMs": now_ms() - started})
                except Exception as e:
                    audit.log({"kind": "result", "clientId": client_id, "requestId": req_id, "ok": False, "elapsedMs": now_ms() - started, "error": str(e)})
                    await ws.send(json.dumps({"type": "result", "requestId": req_id, "ok": False, "error": {"code": "E_INTERNAL", "message": str(e)}}, ensure_ascii=False))
        finally:
            audit.log({"kind": "client_disconnect", "clientId": client_id})

    async with websockets.serve(handler, cfg.host, cfg.port, max_size=4 * 1024 * 1024):
        await asyncio.Future()


if __name__ == "__main__":
    asyncio.run(main())


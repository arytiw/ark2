from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, List, Literal, Optional, Tuple, TypedDict, Union


class EmbedRequest(TypedDict):
    type: Literal["embed"]
    requestId: str
    texts: List[str]


class UpsertItem(TypedDict):
    id: str
    text: str
    meta: Dict[str, Any]


class UpsertRequest(TypedDict):
    type: Literal["upsert"]
    requestId: str
    items: List[UpsertItem]


class QueryRequest(TypedDict):
    type: Literal["query"]
    requestId: str
    text: str
    topK: int


ClientMsg = Union[EmbedRequest, UpsertRequest, QueryRequest]


class ErrorObj(TypedDict):
    code: str
    message: str


class ReadyMsg(TypedDict):
    type: Literal["ready"]
    version: str


class ErrorMsg(TypedDict):
    type: Literal["error"]
    requestId: Optional[str]
    error: ErrorObj


class EmbedResult(TypedDict):
    vectors: List[List[float]]
    dim: int


class ToolResultOk(TypedDict):
    type: Literal["result"]
    requestId: str
    ok: Literal[True]
    result: Any


class ToolResultErr(TypedDict):
    type: Literal["result"]
    requestId: str
    ok: Literal[False]
    error: ErrorObj


ServerMsg = Union[ReadyMsg, ErrorMsg, ToolResultOk, ToolResultErr]


def is_record(v: Any) -> bool:
    return isinstance(v, dict)


def is_non_empty_str(v: Any) -> bool:
    return isinstance(v, str) and len(v) > 0


def validate_client_msg(raw: Any, *, max_batch: int, max_text_bytes: int) -> Tuple[Optional[ClientMsg], Optional[ErrorObj]]:
    if not is_record(raw):
        return None, {"code": "E_BAD_JSON", "message": "Message must be a JSON object."}
    t = raw.get("type")
    if t == "embed":
        if not is_non_empty_str(raw.get("requestId")):
            return None, {"code": "E_BAD_REQUEST", "message": "requestId must be non-empty string."}
        texts = raw.get("texts")
        if not isinstance(texts, list) or not all(isinstance(x, str) for x in texts):
            return None, {"code": "E_BAD_REQUEST", "message": "texts must be string array."}
        if len(texts) == 0 or len(texts) > max_batch:
            return None, {"code": "E_BAD_REQUEST", "message": "texts batch size out of bounds."}
        for s in texts:
            if len(s.encode("utf-8")) > max_text_bytes:
                return None, {"code": "E_TOO_LARGE", "message": "text exceeds maxTextBytes."}
        return raw, None
    if t == "upsert":
        if not is_non_empty_str(raw.get("requestId")):
            return None, {"code": "E_BAD_REQUEST", "message": "requestId must be non-empty string."}
        items = raw.get("items")
        if not isinstance(items, list) or len(items) == 0 or len(items) > max_batch:
            return None, {"code": "E_BAD_REQUEST", "message": "items must be non-empty array with bounded length."}
        for it in items:
            if not is_record(it):
                return None, {"code": "E_BAD_REQUEST", "message": "item must be an object."}
            if not is_non_empty_str(it.get("id")):
                return None, {"code": "E_BAD_REQUEST", "message": "item.id must be non-empty string."}
            if not isinstance(it.get("text"), str):
                return None, {"code": "E_BAD_REQUEST", "message": "item.text must be string."}
            if len(it["text"].encode("utf-8")) > max_text_bytes:
                return None, {"code": "E_TOO_LARGE", "message": "item.text exceeds maxTextBytes."}
            meta = it.get("meta")
            if not is_record(meta):
                return None, {"code": "E_BAD_REQUEST", "message": "item.meta must be an object."}
        return raw, None
    if t == "query":
        if not is_non_empty_str(raw.get("requestId")):
            return None, {"code": "E_BAD_REQUEST", "message": "requestId must be non-empty string."}
        if not isinstance(raw.get("text"), str) or len(raw["text"]) == 0:
            return None, {"code": "E_BAD_REQUEST", "message": "text must be non-empty string."}
        if len(raw["text"].encode("utf-8")) > max_text_bytes:
            return None, {"code": "E_TOO_LARGE", "message": "text exceeds maxTextBytes."}
        topk = raw.get("topK")
        if not isinstance(topk, int) or topk < 1 or topk > 100:
            return None, {"code": "E_BAD_REQUEST", "message": "topK must be int in [1, 100]."}
        return raw, None
    return None, {"code": "E_BAD_REQUEST", "message": "Unknown message type."}


# Offline AI Coding Assistant (Air-Gapped)

This repository is being built in **phases**. Each phase is runnable.

## Dependencies + configuration (applies to all phases)

### Runtime dependencies

- **Node.js**: Required for `runtime/`, `tools/`, `agent/`, `context/`, and `extension/`
  - This repo currently uses **TypeScript** and `npm` workspaces.
- **VS Code**: Required only if you are using `extension/`
- **Python 3**: Required only if you are using `embeddings/` (Phase 6+)

### Optional local binaries / models (still fully offline)

- **llama.cpp** (optional): Required only if `config.json` has `"llm.backend": "llamacpp"`
  - Binary path: `llm.llamaBinPath` (default `./runtime/bin/llama-cli`)
  - Model path: `llm.modelPath` (default `./models/your-model.gguf`)

- **Ollama** (optional): Required only if `config.json` has `"llm.backend": "ollama"`
  - Base URL: `llm.ollamaBaseUrl` (default `http://127.0.0.1:11434`)
  - Model name: `llm.ollamaModel` (example: `gpt-oss:20b`)
  - Note: For offline/air-gapped operation, this runtime enforces **localhost/127.0.0.1 only** for `ollamaBaseUrl`.
- **Embedding model + embed binary** (optional): Required only if `config.json` has `"embeddings.backend"` set to a real backend (not `"mock"`)
  - Binary path: `embeddings.llamaBinPath` (default `./embeddings/bin/llama-embed`)
  - Model path: `embeddings.modelPath` (default `./models/your-embedder.gguf`)

### Language/library dependencies (by package)

- **Node packages** (all local, no cloud required)
  - `ws` (WebSocket IPC)
  - `typescript` (build)
  - Types: `@types/node`, `@types/ws`, and (extension only) `@types/vscode`
- **Python packages** (embeddings service only)
  - `faiss-cpu==1.12.0`
  - `websockets==15.0.1`

### Secrets, API keys, and environment variables

- **No API keys are required.** This system is designed to be fully offline and does not integrate with cloud model providers.
- **No environment variables are required by default.** Configuration is read from `config.json`.
- **Sensitive values that should never be committed**
  - If you choose to add your own integrations later, treat any `*_TOKEN`, `*_KEY`, `*_SECRET`, or credentials as secrets and keep them out of the repo.

### Single source of truth: `config.json`

All services read host/port and limits from `config.json`.

- **Ports / hosts**
  - `runtime.host`, `runtime.port` (default `127.0.0.1:8765`)
  - `tools.host`, `tools.port` (default `127.0.0.1:8766`)
  - `agent.host`, `agent.port` (default `127.0.0.1:8767`)
  - `embeddings.host`, `embeddings.port` (default `127.0.0.1:8768`)
- **Audit logs**
  - `runtime.auditLogDir`, `tools.auditLogDir`, `agent.auditLogDir`, `embeddings.auditLogDir`, `context.auditLogDir`
- **Determinism & safety controls**
  - Runtime: `llm.seed`, `llm.temperature`, `llm.topP`, `llm.threads`, `llm.gpuLayers`
  - Tools limits: `tools.maxFileBytes`, `tools.maxListEntries`, `tools.maxSearchMatches`, `tools.backupDir`
  - Agent limits: `agent.maxSteps`, `agent.timeoutMs`, `agent.modelSource`, `agent.llmMaxTokens`
  - Context chunking: `context.chunkChars`, `context.chunkOverlap`, `context.maxFiles`

## Phase 1: Local LLM Runtime Wrapper + Streaming API

Phase 1 provides a **local WebSocket server** that streams tokens from a local LLM backend:

- `llm.backend="mock"` (default): no model required, streams mock tokens
- `llm.backend="llamacpp"`: wraps a local `llama.cpp` CLI binary (`llama-cli`) and streams stdout

### Folder tree (Phase 1)

```
project-root/
├── config.json
├── README.md
├── runtime/
│   ├── package.json
│   ├── tsconfig.json
│   └── src/
│       ├── index.ts
│       ├── config.ts
│       ├── logger.ts
│       ├── types.ts
│       ├── validate.ts
│       └── backends/
│           ├── llamacpp.ts
│           └── mock.ts
└── shared/
    └── config.schema.json
```

### Run (Windows PowerShell)

From `project-root/`:

```powershell
cd runtime
npm install
npm run build
npm run start
```

The WebSocket server binds to `config.json` `runtime.host` + `runtime.port` (default `127.0.0.1:8765`).

### WebSocket protocol

Server sends on connect:

- `{ "type": "ready", "version": "0.1.0" }`

Client -> server messages:

- Generate:
  - `{ "type": "generate", "requestId": "1", "prompt": "Hello", "maxTokens": 256, "stop": ["\n\n"] }`
- Cancel:
  - `{ "type": "cancel", "requestId": "1" }`
- Ping:
  - `{ "type": "ping", "requestId": "p1" }`

Server -> client streaming:

- `{ "type": "token", "requestId": "1", "token": "..." }` (many)
- `{ "type": "done", "requestId": "1", "reason": "eos" | "stop" | "cancel" | "error" }`
- `{ "type": "error", "requestId": "1", "code": "...", "message": "..." }`

### Configure llama.cpp

Edit `config.json`:

- Set `"llm.backend": "llamacpp"`
- Set `"llm.modelPath"` to your GGUF
- Set `"llm.llamaBinPath"` to your local `llama-cli` path

This wrapper **does not** accept arbitrary user-provided flags; only the prompt is client-controlled.

### Audit logging

All connections and requests are logged as JSONL to `runtime.auditLogDir` (default `./runtime/audit`).

### Performance considerations (Phase 1)

- Streaming uses WebSockets and avoids synchronous work in the message handler except minimal JSON parsing and validation.
- Stop-sequence detection is a simple scan; if it becomes a hotspot we can switch to a streaming matcher (Aho–Corasick) without changing interfaces.
- The current audit logger uses `appendFileSync` for simplicity; if this affects throughput on slower disks, we will replace it with a buffered async writer behind the same `AuditLogger` interface.

## Phase 2: VS Code Extension Integration

Phase 2 adds a minimal VS Code extension that connects to the Phase 1 runtime over **local WebSocket IPC** and streams tokens into an Output Channel.

### Folder tree (Phase 1 + Phase 2)

```
project-root/
├── config.json
├── package.json
├── README.md
├── runtime/...
├── extension/
│   ├── package.json
│   ├── tsconfig.json
│   └── src/
│       ├── extension.ts
│       ├── protocol.ts
│       └── runtimeClient.ts
└── shared/...
```

### Run / debug the extension

1) Start the runtime (Phase 1):

```powershell
cd runtime
npm install
npm run build
npm run start
```

2) Build the extension:

```powershell
cd ..\extension
npm install
npm run build
```

3) In VS Code:

- Open `project-root/` as a folder.
- Run **Run and Debug** → **Run Extension** (uses VS Code’s extension host).
- In the extension host window, run command palette:
  - `Offline Assistant: Connect to Runtime`
  - `Offline Assistant: Generate (Stream to Output)`
  - `Offline Assistant: Cancel Current Generation`

### Performance considerations (Phase 2)

- Runtime connect is bounded with a short handshake timeout (defaults to 1500ms).
- Token handling is streaming and UI-friendly (OutputChannel append).
- No shell execution is performed by the extension.

## Phase 3: Completion Pipeline

Phase 3 adds an **inline completion pipeline**:

- Builds a **bounded prompt** from the active editor (prefix/suffix around cursor)
- Calls the local runtime using the same streaming protocol
- Supports **cancellation** via VS Code cancellation token
- Returns the final completion as an inline suggestion (VS Code applies the suggestion at once)

### Run (Phase 3)

Same as Phase 2, plus:

- Ensure the runtime is running (`npm run start` in `runtime/`)
- In the extension host window:
  - Start typing in a file and wait for inline completion, or trigger VS Code inline suggestions as usual.
  - Use `Offline Assistant: Toggle Inline Completion` if you want to disable it.

### Settings

- `offlineAssistant.inlineCompletionEnabled` (default true)
- `offlineAssistant.completionMaxTokens` (default 256)
- `offlineAssistant.maxPrefixChars` (default 8000)
- `offlineAssistant.maxSuffixChars` (default 2000)

### Performance considerations (Phase 3)

- Prompt construction is O(prefix+suffix) and bounded by settings, designed to stay low-latency.
- No synchronous disk reads on the completion path (document text is in-memory).
- Token stream is buffered until `done` to fit VS Code’s inline completion API; streaming is still used for runtime responsiveness and cancellation.

## Phase 4: Tool System

Phase 4 adds a dedicated **Tools Service** (Node.js) that exposes a deterministic tool API over **local WebSocket IPC**.

### Tools (Phase 4)

- `read_file(path)`
- `write_file(path, content)` (writes are **reversible** via automatic backups)
- `apply_diff(path, diff)` (safe unified-diff application with context checks)
- `list_files(directory)`
- `search_code(query, directory?)`

### Security + determinism properties

- Workspace sandbox: all paths are constrained to the workspace root (prevents `..` traversal and symlink escape).
- No shell execution.
- Strict JSON validation of every request.
- All tool calls and results are written as JSONL audit logs.
- File modifications create read-only backups under `tools.backupDir`.

### Run (Phase 4)

```powershell
cd tools
npm install
npm run build
npm run start
```

The tools service binds to `config.json` `tools.host` + `tools.port` (default `127.0.0.1:8766`).

### Tools WebSocket protocol

Client -> server:

```json
{ "type": "tool_call", "requestId": "1", "tool": "read_file", "params": { "path": "README.md" } }
```

Server -> client:

```json
{ "type": "tool_result", "requestId": "1", "ok": true, "result": { "...": "..." } }
```

or

```json
{ "type": "tool_result", "requestId": "1", "ok": false, "error": { "code": "E_...", "message": "..." } }
```

### Performance considerations (Phase 4)

- All operations are bounded (`maxFileBytes`, `maxListEntries`, `maxSearchMatches`) to prevent unbounded memory/CPU use.
- Tool execution uses async filesystem APIs; no blocking shell calls.
- Diff application is linear in file size + diff size.

## Phase 5: Agent Controller

Phase 5 adds an **Agent Controller Service** (`agent/`) that runs a constrained iterative loop:

- Model proposes exactly **one JSON action** per step (tool call or final answer)
- System validates action (tool allowlist + params shape)
- Tools Service executes deterministically (sandboxed, reversible edits)
- Tool results are appended to context for the next step
- Hard limits: `maxSteps`, `timeoutMs`, cancellation

### Run (Phase 5)

1) Start Tools Service (Phase 4):

```powershell
cd tools
npm install
npm run build
npm run start
```

2) (Optional) Start Runtime (Phase 1) if using `agent.modelSource="runtime"`:

```powershell
cd ..\runtime
npm install
npm run build
npm run start
```

3) Start Agent Service:

```powershell
cd ..\agent
npm install
npm run build
npm run start
```

The agent binds to `config.json` `agent.host` + `agent.port` (default `127.0.0.1:8767`).

### Agent WebSocket protocol (Phase 5)

Client -> agent:

```json
{ "type": "task", "taskId": "t1", "instruction": "read README.md" }
```

Cancel:

```json
{ "type": "cancel", "taskId": "t1" }
```

Agent -> client:

- `event` messages for steps/tool calls/results
- `final` message with result

### Notes

- For Phase 5 to be runnable without a real model, `config.json` defaults to `agent.modelSource="mock"`, which supports:
  - `read <path>`
  - `search <query>`
- Set `agent.modelSource="runtime"` to drive tool selection from the local LLM runtime (must output strict JSON actions).

## Phase 6: Context Engine (Code-aware RAG)

Phase 6 adds:

- `embeddings/`: a **Python WebSocket microservice** that embeds text and maintains a **FAISS vector index** (offline)
- `context/`: a **Node context engine** that builds/querys the index by reading workspace files via the **Tools Service**

### Run (Phase 6)

1) Start Tools Service (Phase 4):

```powershell
cd tools
npm install
npm run build
npm run start
```

2) Start Embeddings Service (Python):

```powershell
cd ..\embeddings
python -m venv .venv
.\.venv\Scripts\pip install -r requirements.txt
.\.venv\Scripts\python -m src.server
```

3) Build the Context Engine and build the index:

```powershell
cd ..\context
npm install
npm run build
npm run build-index
```

4) Query the index:

```powershell
npm run query -- "websocket"
```

### Notes (Phase 6)

- Default embedding backend is `embeddings.backend="mock"` for fully-offline runnable behavior without any model.
- The FAISS index persists under `embeddings.indexDir` and grows append-only in this phase.
- Next integration step (after Phase 6) is wiring retrieval into the completion prompt + agent loop.

## Phase 6.1: RAG wired into completion + agent

Retrieval is now consumed by:

- **VS Code inline completion** (Phase 3): queries the embeddings service for top-k snippets (tight timeout) and injects them into the completion prompt.
- **Agent controller** (Phase 5, `modelSource="runtime"`): queries embeddings each step and injects retrieved snippets into the model prompt.

### Run (Phase 6.1)

1) Start Tools + Embeddings (and ensure an index exists):

```powershell
cd tools
npm run start

cd ..\embeddings
python -m src.server

cd ..\context
npm run build-index
```

2) Run the VS Code extension (Phase 2/3):

- Build `extension/` and run **Run Extension**
- Inline completions will now include a bounded “Retrieved code context” section when embeddings is reachable

### Settings (extension)

- `offlineAssistant.ragTopK` (default 6)
- `offlineAssistant.ragTimeoutMs` (default 80)

### Failure behavior

- If embeddings is down / slow, retrieval **fails closed** (no snippets) and completion continues normally.


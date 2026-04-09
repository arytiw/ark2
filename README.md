# Offline AI Coding Assistant (Local & Air-Gapped)

An open-source, fully offline coding assistant designed to work as a local alternative to Cursor or Cline. It uses **Ollama** or **llama.cpp** for intelligence and a sandboxed tool service for safe filesystem operations.

## 🚀 Quick Start (Complete Setup)

If you just cloned this repository, follow these steps to get your own air-gapped coding agent running.

### 1. Prerequisites
- **Node.js (v18+)**: Core runtime for most services.
- **VS Code**: To use the assistant sidebar.
- **Ollama** (Recommended): To provide the LLM brain.
- **Python 3.10+**: Only for the embeddings service (code context/RAG).

### 2. Install & Build
Run the build script from the root to install dependencies and compile all TypeScript services:

```powershell
# In the project root
npm install
npm run build:all
```
*(Note: If `npm run build:all` is not in your root package.json, you can manually build each directory: `runtime`, `tools`, `agent`, `extension`)*

### 3. Configure your LLM
Copy `config.json` and adjust it to point to your local LLM (defaults to Ollama):

```json
"llm": {
  "backend": "ollama",
  "ollamaBaseUrl": "http://127.0.0.1:11434",
  "ollamaModel": "qwen2.5-coder:latest"
}
```

### 4. Start the Backend Services
Open four terminal windows and start the core stack:

1. **Local Runtime** (The LLM Gateway):
   ```powershell
   cd runtime && npm run start
   ```
2. **Tools Service** (The Filesystem Sandbox):
   ```powershell
   cd tools && npm run start
   ```
3. **Agent Controller** (The Orchestrator):
   ```powershell
   cd agent && npm run start
   ```
4. **Embeddings Service** (Optional - for Context/RAG):
   ```powershell
   cd embeddings
   # Create venv and install requirements.txt first
   python -m src.server
   ```

### 5. Launch the VS Code Extension
1. Open the project root in VS Code.
2. Press `F5` or go to **Run and Debug** -> **Run Extension**.
3. A new VS Code window will open. Click the "Offline Assistant" icon in the Activity Bar (Sidebar).
4. Click **Connect to Runtime** to bridge the UI to your local services.

---

## 🏗️ Architecture

This project is built as a series of decoupled microservices that communicate over local WebSockets:

- **Runtime (8765)**: Handles token streaming and model backend abstraction (Mock, Llama.cpp, or Ollama).
- **Tools (8766)**: A secure sandbox that allows the agent to read/write files, apply diffs, and search code safely.
- **Agent (8767)**: The cognitive loop. It plans tasks, selects tools, and verifies results.
- **Embeddings (8768)**: A Python service using FAISS for lightning-fast local code search.
- **Extension**: The VS Code UI that provides the Chat sidebar, inline completions, and reasoning transparency.

---

## 🧠 Agent Modes

The sidebar supports three specialized modes:

- **Chat (No Tools)**: Pure assistant mode. Great for explanations or quick questions where the agent shouldn't touch your files.
- **Agent (Autonomous)**: Full Plan-Execute-Verify loop. The agent will read your code, propose changes, and apply them.
- **Plan (Design Only)**: The agent will walk through the architecture and create a step-by-step implementation plan but will **not** execute any tools.

---

## 🔍 Features

### Incremental Streaming
The UI uses an optimized token buffer to provide smooth, high-fps streaming even when using smaller local models.

### Reasoning Transparency
Expand the **"Reasoning Steps"** panel in the sidebar to see exactly what the agent is thinking, which tools it's calling, and the outcome of every orchestration step.

### Reversible Edits
Every file modification made by the agent is automatically backed up in a local `.backup` directory (configurable in `config.json`), ensuring you can always roll back.

### Structured Logging
All services output structured JSON logs to the console, making it easy to trace a request across the entire system.

---

## 🛠️ Internal Protocol

The system uses a standardized JSON-over-WebSocket protocol. 

**Task Request Example:**
```json
{
  "type": "task",
  "taskId": "t1",
  "instruction": "Refactor auth.ts to use JWT",
  "mode": "agent"
}
```

**Streamed Event Example:**
```json
{
  "type": "event",
  "taskId": "t1",
  "event": {
    "kind": "tool_call",
    "step": 2,
    "tool": "read_file",
    "params": { "path": "src/auth.ts" }
  }
}
```

---

## 🔒 Security & Privacy

- **100% Offline**: No telemetry, no cloud API calls, and no data leaves your machine.
- **Localhost Only**: The Ollama and Tooling backends are strictly enforced to `127.0.0.1` to prevent any remote access to your files.
- **Sandboxed**: Tool operations are bounded by file size and directory depth to prevent resource exhaustion.

---

## 📜 Legal
This project is for educational and local development use. Ensure you have the rights to the models you download via Ollama or Llama.cpp.

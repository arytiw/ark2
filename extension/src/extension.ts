import * as vscode from "vscode";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { RuntimeClient } from "./runtimeClient";
import type { ServerToClient } from "./protocol";
import { InlineCompletionPipeline } from "./completionProvider";
import { EmbeddingsClient } from "./embeddingsClient";
import { ChatWebviewProvider } from "./chatWebviewProvider";
import { AgentClient, type AgentEvent } from "./agentClient";

type RootConfig = {
  runtime: { host: string; port: number };
  embeddings: { host: string; port: number };
  agent: { host: string; port: number };
};

function tryReadRootConfig(workspaceRoot: string): RootConfig | null {
  try {
    const p = path.join(workspaceRoot, "config.json");
    const raw = JSON.parse(fs.readFileSync(p, "utf8")) as unknown;
    if (typeof raw !== "object" || raw === null) return null;
    const r = (raw as any).runtime;
    const e = (raw as any).embeddings;
    const a = (raw as any).agent;
    if (!r || typeof r.host !== "string" || typeof r.port !== "number") return null;
    if (!e || typeof e.host !== "string" || typeof e.port !== "number") return null;
    if (!a || typeof a.host !== "string" || typeof a.port !== "number") return null;
    return {
      runtime: { host: r.host, port: r.port },
      embeddings: { host: e.host, port: e.port },
      agent: { host: a.host, port: a.port }
    };
  } catch {
    return null;
  }
}

function getWorkspaceRoot(): string | null {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) return null;
  return folders[0].uri.fsPath;
}

function newRequestId(): string {
  return crypto.randomBytes(8).toString("hex");
}

export function activate(context: vscode.ExtensionContext) {
  const output = vscode.window.createOutputChannel("Offline Assistant", { log: true });
  output.appendLine("Extension activated.");

  let client: RuntimeClient | null = null;
  let embClient: EmbeddingsClient | null = null;
  let agentClient: AgentClient | null = null;
  let inflightRequestId: string | null = null;
  let inlinePipeline: InlineCompletionPipeline | null = null;

  const ensureClient = async (): Promise<RuntimeClient> => {
    const root = getWorkspaceRoot();
    if (!root) throw new Error("Open a workspace folder first.");
    const cfg = tryReadRootConfig(root);
    if (!cfg) throw new Error("Missing/invalid config.json at workspace root.");

    const url = `ws://${cfg.runtime.host}:${cfg.runtime.port}`;
    if (!client) {
      client = new RuntimeClient({ url });
      client.onState((s) => output.appendLine(`runtime: ${s}`));
      client.onMessage((m) => onRuntimeMessage(m));
    }
    await client.connect();
    output.appendLine(`Connected to ${url}`);
    return client;
  };

  const ensureEmbClient = async (): Promise<EmbeddingsClient> => {
    const root = getWorkspaceRoot();
    if (!root) throw new Error("Open a workspace folder first.");
    const cfg = tryReadRootConfig(root);
    if (!cfg) throw new Error("Missing/invalid config.json at workspace root.");
    const url = `ws://${cfg.embeddings.host}:${cfg.embeddings.port}`;
    if (!embClient) embClient = new EmbeddingsClient(url);
    await embClient.connect();
    return embClient;
  };

  const ensureAgentClient = async (): Promise<AgentClient> => {
    const root = getWorkspaceRoot();
    if (!root) throw new Error("Open a workspace folder first.");
    const cfg = tryReadRootConfig(root);
    if (!cfg) throw new Error("Missing/invalid config.json at workspace root.");
    const url = `ws://${cfg.agent.host}:${cfg.agent.port}`;
    if (!agentClient) {
      agentClient = new AgentClient(url);
      agentClient.onState((s) => {
        output.appendLine(`agent: ${s}`);
        console.log(JSON.stringify({ service: "extension", event: "agent_state_change", state: s }));
      });
    }
    await agentClient.connect();
    console.log(JSON.stringify({ service: "extension", event: "agent_connected", url }));
    return agentClient;
  };

  const retrieveRagSnippets = async (query: string, topK: number, timeoutMs: number) => {
    const c = await ensureEmbClient();
    return c.query(query, topK, timeoutMs);
  };

  const onRuntimeMessage = (m: ServerToClient) => {
    if (m.type === "ready") {
      output.appendLine(`runtime ready: v${m.version}`);
      return;
    }
    if (m.type === "token") {
      output.append(m.token);
      return;
    }
    if (m.type === "done") {
      output.appendLine(`\n[done ${m.requestId}] reason=${m.reason}`);
      if (inflightRequestId === m.requestId) inflightRequestId = null;
      return;
    }
    if (m.type === "error") {
      output.appendLine(`[error] code=${m.code} requestId=${m.requestId ?? "-"} msg=${m.message}`);
      return;
    }
  };

  // Phase 3: completion pipeline
  const initInlineCompletion = () => {
    if (inlinePipeline) return;
    const cfg = vscode.workspace.getConfiguration("offlineAssistant");
    inlinePipeline = new InlineCompletionPipeline(
      output,
      ensureClient,
      retrieveRagSnippets,
      {
        maxTokens: cfg.get<number>("completionMaxTokens", 256),
        stop: [],
        maxPrefixChars: cfg.get<number>("maxPrefixChars", 8000),
        maxSuffixChars: cfg.get<number>("maxSuffixChars", 2000),
        ragTopK: cfg.get<number>("ragTopK", 6),
        ragTimeoutMs: cfg.get<number>("ragTimeoutMs", 80)
      }
    );
    inlinePipeline.register(context);
    output.appendLine("Inline completion provider registered.");
  };
  initInlineCompletion();

  context.subscriptions.push(
    vscode.commands.registerCommand("offlineAssistant.connect", async () => {
      output.show(true);
      try {
        await ensureClient();
      } catch (e) {
        vscode.window.showErrorMessage(e instanceof Error ? e.message : "Connect failed.");
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("offlineAssistant.generate", async () => {
      output.show(true);
      try {
        const c = await ensureClient();
        const prompt = await vscode.window.showInputBox({
          title: "Offline Assistant Prompt",
          prompt: "Enter a prompt to stream from the local runtime",
          ignoreFocusOut: true
        });
        if (!prompt) return;

        if (inflightRequestId) {
          vscode.window.showWarningMessage("A request is already running. Cancel it first.");
          return;
        }

        const requestId = newRequestId();
        inflightRequestId = requestId;
        output.appendLine(`\n[generate ${requestId}]`);
        c.send({ type: "generate", requestId, prompt, maxTokens: 512, stop: [] });
      } catch (e) {
        inflightRequestId = null;
        vscode.window.showErrorMessage(e instanceof Error ? e.message : "Generate failed.");
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("offlineAssistant.cancel", async () => {
      output.show(true);
      try {
        const c = await ensureClient();
        if (!inflightRequestId) {
          vscode.window.showInformationMessage("No in-flight request to cancel.");
          return;
        }
        const rid = inflightRequestId;
        inflightRequestId = null;
        c.send({ type: "cancel", requestId: rid });
        output.appendLine(`[cancel ${rid}] sent`);
      } catch (e) {
        vscode.window.showErrorMessage(e instanceof Error ? e.message : "Cancel failed.");
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("offlineAssistant.toggleInlineCompletion", async () => {
      const cfg = vscode.workspace.getConfiguration("offlineAssistant");
      const cur = cfg.get<boolean>("inlineCompletionEnabled", true);
      await cfg.update("inlineCompletionEnabled", !cur, vscode.ConfigurationTarget.Workspace);
      vscode.window.showInformationMessage(`Offline Assistant inline completion: ${!cur ? "enabled" : "disabled"}`);
    })
  );

  const chatProvider = new ChatWebviewProvider(context.extensionUri);
  chatProvider.onChatMessage(async (value, mode) => {
    console.log(JSON.stringify({ service: "extension", event: "user_prompt", prompt: value, mode }));
    try {
      const ac = await ensureAgentClient();
      chatProvider.startMessage();
      console.log(JSON.stringify({ service: "extension", event: "streaming_start", mode }));

      ac.runTask(value, {
        onEvent: (ev: AgentEvent) => {
          let summary = "";
          if (ev.kind === "step_start") summary = `Starting orchestration step ${ev.step}`;
          else if (ev.kind === "tool_call") summary = `Calling tool: ${ev.tool}`;
          else if (ev.kind === "tool_result") summary = `Tool ${ev.ok ? "success" : "failed"}`;
          else if (ev.kind === "model_action") {
             const action = ev.action as any;
             summary = action.kind || action.action || "AI reasoning";
          }
          
          if (summary) chatProvider.addStep(ev.step, summary);
        },
        onFinal: (res) => {
          console.log(JSON.stringify({ service: "extension", event: "streaming_end", ok: res.ok }));
          if (res.ok && res.result) {
            chatProvider.addToken(res.result);
          } else if (!res.ok && res.error) {
            chatProvider.error(res.error.message);
          }
          chatProvider.endMessage();
        },
        onError: (err) => {
          console.log(JSON.stringify({ service: "extension", event: "streaming_error", error: err.message }));
          chatProvider.error(err.message);
          chatProvider.endMessage();
        }
      }, mode);
    } catch (e) {
      chatProvider.error(e instanceof Error ? e.message : "Failed to start agent task.");
    }
  });

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ChatWebviewProvider.viewType, chatProvider)
  );
}

export function deactivate() {
  // No-op: VS Code disposes subscriptions.
}


import * as vscode from "vscode";

export class ChatWebviewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "offlineAssistant.chat";
  private _view?: vscode.WebviewView;

  constructor(private readonly _extensionUri: vscode.Uri) {}

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ) {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri],
    };

    webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

    webviewView.webview.onDidReceiveMessage((data) => {
      switch (data.type) {
        case "sendMessage": {
          this._onDidReceiveChatMessage?.(data.value, data.mode);
          break;
        }
      }
    });
  }

  private _onDidReceiveChatMessage?: (value: string, mode: "chat" | "agent" | "plan") => void;

  public onChatMessage(cb: (value: string, mode: "chat" | "agent" | "plan") => void) {
    this._onDidReceiveChatMessage = cb;
  }

  public startMessage() {
    this._view?.webview.postMessage({ type: "startMessage" });
  }

  public addToken(value: string) {
    this._view?.webview.postMessage({ type: "addToken", value });
  }

  public endMessage() {
    this._view?.webview.postMessage({ type: "endMessage" });
  }

  public addStep(step: number, value: string) {
    this._view?.webview.postMessage({ type: "addStep", step, value });
  }

  public error(value: string) {
    this._view?.webview.postMessage({ type: "error", value });
  }

  private _getHtmlForWebview(webview: vscode.Webview) {
    const nonce = getNonce();

    return `<!DOCTYPE html>
			<html lang="en">
			<head>
				<meta charset="UTF-8">
				<meta name="viewport" content="width=device-width, initial-scale=1.0">
				<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
				<title>Offline Assistant Chat</title>
				<style>
					body {
						padding: 10px;
						display: flex;
						flex-direction: column;
						height: 100vh;
						box-sizing: border-box;
						color: var(--vscode-foreground);
						font-family: var(--vscode-font-family);
						margin: 0;
					}
					#container {
						display: flex;
						flex-direction: column;
						height: 100%;
					}
					#message-list {
						flex-grow: 1;
						overflow-y: auto;
						margin-bottom: 10px;
						display: flex;
						flex-direction: column;
						gap: 12px;
						padding-right: 4px;
					}
					.message {
						padding: 10px 14px;
						border-radius: 8px;
						max-width: 85%;
						word-wrap: break-word;
						line-height: 1.5;
						font-size: 13px;
						white-space: pre-wrap;
					}
					.user {
						align-self: flex-end;
						background-color: var(--vscode-button-background);
						color: var(--vscode-button-foreground);
						border-bottom-right-radius: 2px;
					}
					.assistant {
						align-self: flex-start;
						background-color: var(--vscode-editor-inactiveSelectionBackground);
						border-bottom-left-radius: 2px;
					}
					.error {
						align-self: center;
						background-color: var(--vscode-inputValidation-errorBackground);
						color: var(--vscode-inputValidation-errorForeground);
						border: 1px solid var(--vscode-inputValidation-errorBorder);
						font-size: 12px;
						max-width: 100%;
					}
					#steps-container {
						display: none;
						margin: 8px 0;
						padding: 4px;
						border: 1px solid var(--vscode-panel-border);
						border-radius: 4px;
						background: var(--vscode-sideBar-background);
					}
					#steps-container summary {
						padding: 4px 8px;
						cursor: pointer;
						font-size: 11px;
						font-weight: 600;
						color: var(--vscode-descriptionForeground);
						outline: none;
					}
					#steps-container summary:hover {
						color: var(--vscode-foreground);
					}
					#steps-list {
						list-style: none;
						padding: 4px 8px 8px 8px;
						margin: 0;
						font-size: 11px;
						display: flex;
						flex-direction: column;
						gap: 4px;
						max-height: 150px;
						overflow-y: auto;
					}
					.step-item {
						display: flex;
						gap: 6px;
						color: var(--vscode-descriptionForeground);
						border-left: 2px solid var(--vscode-button-secondaryBackground);
						padding-left: 8px;
					}
					.step-number {
						font-weight: 600;
						min-width: 45px;
					}
					#typing-indicator {
						display: none;
						align-self: flex-start;
						padding: 8px 12px;
						font-style: italic;
						font-size: 11px;
						color: var(--vscode-descriptionForeground);
						animation: pulse 1.5s infinite;
					}
					@keyframes pulse {
						0% { opacity: 0.6; }
						50% { opacity: 1; }
						100% { opacity: 0.6; }
					}
					#input-area {
						display: flex;
						flex-direction: column;
						gap: 8px;
						padding-bottom: 20px;
						background: var(--vscode-sideBar-background);
					}
					#mode-selector {
						padding: 6px;
						background: var(--vscode-dropdown-background);
						color: var(--vscode-dropdown-foreground);
						border: 1px solid var(--vscode-dropdown-border);
						border-radius: 4px;
						font-size: 12px;
					}
					textarea {
						width: 100%;
						min-height: 80px;
						resize: none;
						background: var(--vscode-input-background);
						color: var(--vscode-input-foreground);
						border: 1px solid var(--vscode-input-border);
						padding: 8px;
						box-sizing: border-box;
						border-radius: 4px;
						font-family: inherit;
					}
					textarea:focus {
						outline: 1px solid var(--vscode-focusBorder);
						border-color: var(--vscode-focusBorder);
					}
					button {
						padding: 10px;
						background: var(--vscode-button-background);
						color: var(--vscode-button-foreground);
						border: none;
						cursor: pointer;
						border-radius: 4px;
						font-weight: 600;
					}
					button:hover {
						background: var(--vscode-button-hoverBackground);
					}
					::-webkit-scrollbar {
						width: 6px;
					}
					::-webkit-scrollbar-thumb {
						background: var(--vscode-scrollbarSlider-background);
						border-radius: 3px;
					}
					::-webkit-scrollbar-thumb:hover {
						background: var(--vscode-scrollbarSlider-hoverBackground);
					}
				</style>
			</head>
			<body>
				<div id="container">
					<div id="message-list"></div>
					<details id="steps-container">
						<summary>Reasoning Steps</summary>
						<div id="steps-list"></div>
					</details>
					<div id="typing-indicator">Assistant is thinking...</div>
					<div id="input-area">
						<select id="mode-selector">
							<option value="chat">Chat (No Tools)</option>
							<option value="agent">Agent (Autonomous)</option>
							<option value="plan">Plan (Design Only)</option>
						</select>
						<textarea id="chat-input" placeholder="Ask a question or give a task..."></textarea>
						<button id="send-btn">Send</button>
					</div>
				</div>
				<script nonce="${nonce}">
					const vscode = acquireVsCodeApi();
					const messageList = document.getElementById('message-list');
					const chatInput = document.getElementById('chat-input');
					const sendBtn = document.getElementById('send-btn');
					const modeSelector = document.getElementById('mode-selector');
					const typingIndicator = document.getElementById('typing-indicator');
					const stepsContainer = document.getElementById('steps-container');
					const stepsList = document.getElementById('steps-list');

					let currentMessageElement = null;
					let tokenBuffer = '';
					let updateRequested = false;

					function scrollToBottom() {
						messageList.scrollTo({
							top: messageList.scrollHeight,
							behavior: 'smooth'
						});
					}

					function applyBatchUpdates() {
						if (!currentMessageElement || !tokenBuffer) {
							updateRequested = false;
							return;
						}
						currentMessageElement.textContent += tokenBuffer;
						tokenBuffer = '';
						scrollToBottom();
						updateRequested = false;
					}

					window.addEventListener('message', event => {
						const message = event.data;
						switch (message.type) {
							case 'startMessage': {
								typingIndicator.style.display = 'block';
								currentMessageElement = document.createElement('div');
								currentMessageElement.className = 'message assistant';
								messageList.appendChild(currentMessageElement);
								scrollToBottom();
								break;
							}
							case 'addToken': {
								tokenBuffer += message.value;
								if (!updateRequested) {
									updateRequested = true;
									setTimeout(applyBatchUpdates, 20); // Debounce updates
								}
								break;
							}
							case 'endMessage': {
								applyBatchUpdates();
								typingIndicator.style.display = 'none';
								currentMessageElement = null;
								break;
							}
							case 'addStep': {
								stepsContainer.style.display = 'block';
								const stepDiv = document.createElement('div');
								stepDiv.className = 'step-item';
								stepDiv.innerHTML = \`<span class="step-number">[Step \${message.step}]</span> <span class="step-desc">\${message.value}</span>\`;
								stepsList.appendChild(stepDiv);
								stepsList.scrollTop = stepsList.scrollHeight;
								break;
							}
							case 'error': {
								typingIndicator.style.display = 'none';
								const div = document.createElement('div');
								div.className = 'message error';
								div.textContent = 'Error: ' + message.value;
								messageList.appendChild(div);
								scrollToBottom();
								break;
							}
						}
					});

					function addUserMessage(text) {
						const div = document.createElement('div');
						div.className = 'message user';
						div.textContent = text;
						messageList.appendChild(div);
						scrollToBottom();
					}

					sendBtn.addEventListener('click', () => {
						const value = chatInput.value.trim();
						if (value) {
							const mode = modeSelector.value;
							addUserMessage(value);
							
							// Reset steps for new task
							stepsContainer.style.display = 'none';
							stepsList.innerHTML = '';
							
							vscode.postMessage({ type: 'sendMessage', value, mode });
							chatInput.value = '';
						}
					});

					chatInput.addEventListener('keydown', (e) => {
						if (e.key === 'Enter' && !e.shiftKey) {
							e.preventDefault();
							sendBtn.click();
						}
					});
				</script>
			</body>
			</html>`;
  }
}

function getNonce() {
  let text = "";
  const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}

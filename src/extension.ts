import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { spawn, execSync } from 'child_process';

// ============================================================================
// Types
// ============================================================================

interface ShaperOutput {
  title: string;
  send_to_claude: string;
  assumptions: string[];
  questions: string[];
  verbatim: string;
}

interface SessionMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp?: string;
}

interface ClaudeCliConfig {
  printFlag: string | null;
  systemPromptFlag: string | null;
  systemPromptEnv: string | null;
}

interface MetaEngineerMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}

interface TranscriptMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
}

// ============================================================================
// Constants
// ============================================================================

const SYSTEM_PROMPT = `You are PromptShaper.
Turn messy, spoken dev instructions into a crisp, actionable prompt for a coding agent.

OUTPUT RULES:
- Output JSON only (no markdown fences).
- Preserve meaning; do not invent requirements.
- If something is ambiguous, add it to questions[] (don't guess).
- Keep it concise but specific (checklists > prose).

JSON SCHEMA:
{
  "title": string,
  "send_to_claude": string,
  "assumptions": string[],
  "questions": string[],
  "verbatim": string
}`;

const META_ENGINEER_SYSTEM_PROMPT = `You are Meta Engineer, a third-person advisor for developers working with AI coding assistants.

Your role is to help the user:
- Reflect on their current conversation with their AI assistant
- Formulate better questions and prompts
- Strategize their approach to complex problems
- Clarify their own thinking before asking the main assistant
- Identify what information might be missing from their requests

You have access to the recent conversation context from their Claude Code session.
Be concise, insightful, and help them think through their approach.
Do NOT execute code or make changes - just advise and strategize.`;

// ============================================================================
// Configuration
// ============================================================================

function getConfig() {
  const config = vscode.workspace.getConfiguration('promptShaper');
  return {
    maxAssistantMessages: config.get<number>('maxAssistantMessages', 3),
    maxUserMessages: config.get<number>('maxUserMessages', 2),
    maxTailBytes: config.get<number>('maxTailBytes', 250000),
  };
}

// ============================================================================
// Active Workspace Detection
// ============================================================================

function getActiveWorkspaceRoot(): string | null {
  const workspaceFolders = vscode.workspace.workspaceFolders;

  if (!workspaceFolders || workspaceFolders.length === 0) {
    return null;
  }

  if (workspaceFolders.length === 1) {
    return workspaceFolders[0].uri.fsPath;
  }

  const activeEditor = vscode.window.activeTextEditor;
  if (activeEditor) {
    const activeFile = activeEditor.document.uri;
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(activeFile);
    if (workspaceFolder) {
      return workspaceFolder.uri.fsPath;
    }
  }

  for (const editor of vscode.window.visibleTextEditors) {
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
    if (workspaceFolder) {
      return workspaceFolder.uri.fsPath;
    }
  }

  return workspaceFolders[0].uri.fsPath;
}

// ============================================================================
// Claude Code Session Discovery
// ============================================================================

function getClaudeProjectsPath(): string {
  const home = os.homedir();
  return path.join(home, '.claude', 'projects');
}

function encodeWorkspacePath(workspacePath: string): string {
  return workspacePath.replace(/\//g, '-');
}

async function findJsonlFilesInDir(dir: string): Promise<{ path: string; mtime: Date }[]> {
  const results: { path: string; mtime: Date }[] = [];
  try {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.jsonl') && !entry.name.startsWith('agent-')) {
        const fullPath = path.join(dir, entry.name);
        try {
          const stat = await fs.promises.stat(fullPath);
          if (stat.size > 0) {
            results.push({ path: fullPath, mtime: stat.mtime });
          }
        } catch {
          // Skip
        }
      }
    }
  } catch {
    // Skip
  }
  return results;
}

async function findAllJsonlFiles(dir: string): Promise<{ path: string; mtime: Date }[]> {
  const results: { path: string; mtime: Date }[] = [];

  async function walk(currentDir: string): Promise<void> {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile() && entry.name.endsWith('.jsonl') && !entry.name.startsWith('agent-')) {
        try {
          const stat = await fs.promises.stat(fullPath);
          if (stat.size > 0) {
            results.push({ path: fullPath, mtime: stat.mtime });
          }
        } catch {
          // Skip
        }
      }
    }
  }

  await walk(dir);
  return results;
}

async function findBestSessionFile(workspaceRoot: string): Promise<string | null> {
  const projectsPath = getClaudeProjectsPath();

  if (!fs.existsSync(projectsPath)) {
    return null;
  }

  const encodedPath = encodeWorkspacePath(workspaceRoot);
  const exactDir = path.join(projectsPath, encodedPath);

  if (fs.existsSync(exactDir)) {
    const filesInDir = await findJsonlFilesInDir(exactDir);
    if (filesInDir.length > 0) {
      filesInDir.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
      return filesInDir[0].path;
    }
  }

  const allJsonlFiles = await findAllJsonlFiles(projectsPath);

  if (allJsonlFiles.length === 0) {
    return null;
  }

  const workspaceBasename = path.basename(workspaceRoot).toLowerCase();

  const scored = allJsonlFiles.map(file => {
    let score = 0;
    const filePath = file.path.toLowerCase();
    const encodedLower = encodedPath.toLowerCase();

    if (filePath.includes(encodedLower)) {
      score += 100;
    }

    if (filePath.includes(workspaceBasename)) {
      score += 50;
    }

    const ageMs = Date.now() - file.mtime.getTime();
    const ageHours = ageMs / (1000 * 60 * 60);
    score += Math.max(0, 24 - ageHours);

    return { ...file, score };
  });

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return b.mtime.getTime() - a.mtime.getTime();
  });

  return scored[0]?.path || null;
}

// ============================================================================
// Session Log Parsing
// ============================================================================

async function readFullFile(filePath: string): Promise<string> {
  return fs.promises.readFile(filePath, 'utf-8');
}

async function tailReadFile(filePath: string, maxBytes: number): Promise<string> {
  const stat = await fs.promises.stat(filePath);
  const fileSize = stat.size;

  if (fileSize <= maxBytes) {
    return fs.promises.readFile(filePath, 'utf-8');
  }

  const fd = await fs.promises.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(maxBytes);
    const startPos = fileSize - maxBytes;
    await fd.read(buffer, 0, maxBytes, startPos);
    const content = buffer.toString('utf-8');

    const firstNewline = content.indexOf('\n');
    if (firstNewline === -1) {
      return content;
    }
    return content.slice(firstNewline + 1);
  } finally {
    await fd.close();
  }
}

function parseJsonlMessages(content: string): SessionMessage[] {
  const messages: SessionMessage[] = [];
  const lines = content.split('\n').filter(line => line.trim());

  for (const line of lines) {
    try {
      const obj = JSON.parse(line);

      let role: 'user' | 'assistant' | null = null;
      let msgContent: string | null = null;
      let timestamp: string | undefined;

      if (obj.type === 'user' && obj.message?.content) {
        role = 'user';
        msgContent = extractContent(obj.message.content);
        timestamp = obj.timestamp;
      }
      else if (obj.type === 'assistant' && obj.message?.content) {
        role = 'assistant';
        msgContent = extractContent(obj.message.content);
        timestamp = obj.timestamp;
      }
      else if (obj.role === 'user' || obj.role === 'assistant') {
        role = obj.role;
        msgContent = extractContent(obj.content);
        timestamp = obj.timestamp;
      }
      else if (obj.message?.role === 'user' || obj.message?.role === 'assistant') {
        role = obj.message.role;
        msgContent = extractContent(obj.message.content);
        timestamp = obj.timestamp;
      }

      if (role && msgContent && msgContent.trim()) {
        messages.push({ role, content: msgContent.trim(), timestamp });
      }
    } catch {
      // Skip
    }
  }

  return messages;
}

function extractContent(value: unknown): string | null {
  if (typeof value === 'string') {
    return value;
  }
  if (Array.isArray(value)) {
    const textParts = value
      .map(item => {
        if (typeof item === 'string') return item;
        if (item?.type === 'text' && item?.text) return item.text;
        if (item?.text && !item?.type) return item.text;
        if (item?.content && typeof item.content === 'string') return item.content;
        return '';
      })
      .filter(Boolean);
    return textParts.length > 0 ? textParts.join('\n') : null;
  }
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    if (obj.type === 'text' && obj.text) return String(obj.text);
    if (obj.text) return String(obj.text);
    if (obj.content) return extractContent(obj.content);
  }
  return null;
}

function extractRecentMessages(
  messages: SessionMessage[],
  maxAssistant: number,
  maxUser: number
): { assistantMessages: string[]; userMessages: string[] } {
  const assistantMessages: string[] = [];
  const userMessages: string[] = [];

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === 'assistant' && assistantMessages.length < maxAssistant) {
      assistantMessages.unshift(msg.content);
    } else if (msg.role === 'user' && userMessages.length < maxUser) {
      userMessages.unshift(msg.content);
    }

    if (assistantMessages.length >= maxAssistant && userMessages.length >= maxUser) {
      break;
    }
  }

  return { assistantMessages, userMessages };
}

// ============================================================================
// Claude CLI Detection and Invocation
// ============================================================================

let cachedCliConfig: ClaudeCliConfig | null = null;

function detectClaudeCliConfig(): ClaudeCliConfig {
  if (cachedCliConfig) {
    return cachedCliConfig;
  }

  const config: ClaudeCliConfig = {
    printFlag: '-p',
    systemPromptFlag: '--system-prompt',
    systemPromptEnv: null,
  };

  cachedCliConfig = config;
  return config;
}

function isClaudeCliInstalled(): boolean {
  try {
    execSync('which claude', { encoding: 'utf-8' });
    return true;
  } catch {
    try {
      execSync('where claude', { encoding: 'utf-8' });
      return true;
    } catch {
      return false;
    }
  }
}

async function invokeClaudeCli(payload: string, systemPrompt: string): Promise<string> {
  const cliConfig = detectClaudeCliConfig();

  return new Promise((resolve, reject) => {
    const args: string[] = [];
    const env = { ...process.env };

    if (cliConfig.printFlag) {
      args.push(cliConfig.printFlag);
    }

    args.push('--output-format', 'text');
    args.push('--dangerously-skip-permissions');
    args.push('--no-session-persistence');

    if (cliConfig.systemPromptFlag) {
      args.push(cliConfig.systemPromptFlag, systemPrompt);
      args.push(payload);
    } else {
      const combinedPayload = `[SYSTEM]\n${systemPrompt}\n\n[USER]\n${payload}`;
      args.push(combinedPayload);
    }

    const proc = spawn('claude', args, {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    proc.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('error', (err) => {
      reject(new Error(`Failed to spawn claude CLI: ${err.message}`));
    });

    proc.on('close', (code) => {
      if (timedOut) return;
      if (code === 0 || stdout.trim()) {
        resolve(stdout);
      } else {
        reject(new Error(`Claude CLI exited with code ${code}: ${stderr || 'No output'}`));
      }
    });

    const timeout = setTimeout(() => {
      timedOut = true;
      proc.kill('SIGTERM');
      setTimeout(() => {
        try { proc.kill('SIGKILL'); } catch { /* */ }
      }, 1000);
      reject(new Error('Claude CLI timed out after 120 seconds.'));
    }, 120000);

    proc.on('close', () => clearTimeout(timeout));
  });
}

// ============================================================================
// JSON Parsing
// ============================================================================

function parseShapeOutput(raw: string): ShaperOutput {
  let depth = 0;
  let start = -1;
  let end = -1;

  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (raw[i] === '}') {
      depth--;
      if (depth === 0 && start !== -1) {
        end = i + 1;
        break;
      }
    }
  }

  if (start === -1 || end === -1) {
    throw new Error('No JSON object found in output');
  }

  const jsonStr = raw.slice(start, end);
  const parsed = JSON.parse(jsonStr);

  if (typeof parsed.send_to_claude !== 'string') {
    throw new Error('Missing send_to_claude field');
  }

  return {
    title: parsed.title || 'Untitled',
    send_to_claude: parsed.send_to_claude,
    assumptions: Array.isArray(parsed.assumptions) ? parsed.assumptions : [],
    questions: Array.isArray(parsed.questions) ? parsed.questions : [],
    verbatim: parsed.verbatim || '',
  };
}

// ============================================================================
// Main Panel
// ============================================================================

class PromptShaperPanel {
  public static currentPanel: PromptShaperPanel | undefined;
  private readonly _panel: vscode.WebviewPanel;
  private readonly _extensionUri: vscode.Uri;
  private _disposables: vscode.Disposable[] = [];
  private _metaMessages: MetaEngineerMessage[] = [];
  private _currentTab: 'shaper' | 'meta' | 'transcript' = 'shaper';
  private _transcript: TranscriptMessage[] = [];
  private _isConnected: boolean = false;
  private _sessionFile: string | null = null;

  public static createOrShow(extensionUri: vscode.Uri) {
    const column = vscode.ViewColumn.Beside;

    if (PromptShaperPanel.currentPanel) {
      PromptShaperPanel.currentPanel._panel.reveal(column);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'claudeSpeak',
      'Claude Speak',
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [extensionUri],
      }
    );

    PromptShaperPanel.currentPanel = new PromptShaperPanel(panel, extensionUri);
  }

  private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
    this._panel = panel;
    this._extensionUri = extensionUri;

    this._initializeSession();
    this._update();

    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

    this._panel.webview.onDidReceiveMessage(
      async (message) => {
        switch (message.command) {
          case 'switchTab':
            this._currentTab = message.tab;
            if (message.tab === 'transcript') {
              await this._loadTranscript();
            }
            this._update();
            break;
          case 'shapePrompt':
            await this._handleShapePrompt(message.text);
            break;
          case 'metaQuery':
            await this._handleMetaQuery(message.text);
            break;
          case 'copyToClipboard':
            await vscode.env.clipboard.writeText(message.text);
            vscode.window.showInformationMessage('Copied to clipboard!');
            break;
          case 'clearMetaHistory':
            this._metaMessages = [];
            this._update();
            break;
          case 'refreshTranscript':
            await this._loadTranscript();
            this._update();
            break;
          case 'refreshConnection':
            await this._initializeSession();
            this._update();
            break;
        }
      },
      null,
      this._disposables
    );
  }

  private async _initializeSession() {
    const workspaceRoot = getActiveWorkspaceRoot();
    if (!workspaceRoot) {
      this._isConnected = false;
      this._sessionFile = null;
      return;
    }

    this._sessionFile = await findBestSessionFile(workspaceRoot);
    this._isConnected = this._sessionFile !== null && isClaudeCliInstalled();
  }

  private async _loadTranscript() {
    const workspaceRoot = getActiveWorkspaceRoot();
    if (!workspaceRoot) {
      this._transcript = [];
      return;
    }

    const sessionFile = await findBestSessionFile(workspaceRoot);
    if (!sessionFile) {
      this._transcript = [];
      return;
    }

    try {
      const content = await readFullFile(sessionFile);
      const messages = parseJsonlMessages(content);
      this._transcript = messages.map(m => ({
        role: m.role,
        content: m.content,
        timestamp: m.timestamp || '',
      }));
    } catch {
      this._transcript = [];
    }
  }

  private async _handleShapePrompt(dictation: string) {
    if (!dictation.trim()) return;

    const workspaceRoot = getActiveWorkspaceRoot();
    if (!workspaceRoot) {
      this._sendError('No workspace open.');
      return;
    }

    if (!isClaudeCliInstalled()) {
      this._sendError('Claude CLI not found.');
      return;
    }

    this._panel.webview.postMessage({ command: 'loading', loading: true });

    try {
      const config = getConfig();
      const sessionFile = await findBestSessionFile(workspaceRoot);
      let assistantMessages: string[] = [];
      let userMessages: string[] = [];

      if (sessionFile) {
        try {
          const content = await tailReadFile(sessionFile, config.maxTailBytes);
          const messages = parseJsonlMessages(content);
          const extracted = extractRecentMessages(messages, config.maxAssistantMessages, config.maxUserMessages);
          assistantMessages = extracted.assistantMessages;
          userMessages = extracted.userMessages;
        } catch { /* */ }
      }

      const payload = buildPayload(workspaceRoot, assistantMessages, userMessages, dictation);
      const rawOutput = await invokeClaudeCli(payload, SYSTEM_PROMPT);
      const shaped = parseShapeOutput(rawOutput);

      this._panel.webview.postMessage({ command: 'shapeResult', result: shaped });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this._sendError(`Failed: ${errorMsg}`);
    } finally {
      this._panel.webview.postMessage({ command: 'loading', loading: false });
    }
  }

  private async _handleMetaQuery(query: string) {
    if (!query.trim()) return;

    const workspaceRoot = getActiveWorkspaceRoot();
    if (!workspaceRoot) {
      this._sendError('No workspace open.');
      return;
    }

    if (!isClaudeCliInstalled()) {
      this._sendError('Claude CLI not found.');
      return;
    }

    this._metaMessages.push({ role: 'user', content: query, timestamp: Date.now() });
    this._panel.webview.postMessage({ command: 'loading', loading: true });
    this._update();

    try {
      const config = getConfig();
      const sessionFile = await findBestSessionFile(workspaceRoot);
      let assistantMessages: string[] = [];
      let userMessages: string[] = [];

      if (sessionFile) {
        try {
          const content = await tailReadFile(sessionFile, config.maxTailBytes);
          const messages = parseJsonlMessages(content);
          const extracted = extractRecentMessages(messages, config.maxAssistantMessages, config.maxUserMessages);
          assistantMessages = extracted.assistantMessages;
          userMessages = extracted.userMessages;
        } catch { /* */ }
      }

      const contextParts: string[] = [];
      contextParts.push(`WORKSPACE: ${workspaceRoot}\n`);
      contextParts.push('=== CLAUDE CODE SESSION ===');
      if (userMessages.length > 0) {
        contextParts.push('User messages:');
        userMessages.forEach((msg, i) => contextParts.push(`[${i + 1}] ${msg.slice(0, 1500)}`));
      }
      if (assistantMessages.length > 0) {
        contextParts.push('\nClaude responses:');
        assistantMessages.forEach((msg, i) => contextParts.push(`[${i + 1}] ${msg.slice(0, 1500)}`));
      }
      if (this._metaMessages.length > 1) {
        contextParts.push('\n=== META CONVERSATION ===');
        this._metaMessages.slice(0, -1).slice(-6).forEach(msg => {
          contextParts.push(`[${msg.role}]: ${msg.content}`);
        });
      }
      contextParts.push(`\n=== QUESTION ===\n${query}`);

      const rawOutput = await invokeClaudeCli(contextParts.join('\n'), META_ENGINEER_SYSTEM_PROMPT);
      this._metaMessages.push({ role: 'assistant', content: rawOutput.trim(), timestamp: Date.now() });
      this._update();
    } catch (err) {
      this._metaMessages.pop();
      const errorMsg = err instanceof Error ? err.message : String(err);
      this._sendError(`Failed: ${errorMsg}`);
      this._update();
    } finally {
      this._panel.webview.postMessage({ command: 'loading', loading: false });
    }
  }

  private _sendError(message: string) {
    this._panel.webview.postMessage({ command: 'error', message });
  }

  public dispose() {
    PromptShaperPanel.currentPanel = undefined;
    this._panel.dispose();
    while (this._disposables.length) {
      const x = this._disposables.pop();
      if (x) x.dispose();
    }
  }

  private _update() {
    this._panel.webview.html = this._getHtmlForWebview();
  }

  private _getHtmlForWebview() {
    const nonce = getNonce();
    const workspaceName = path.basename(getActiveWorkspaceRoot() || 'No workspace');

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <title>Claude Speak</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }

    :root {
      --bg: #1a1a1a;
      --bg-secondary: #252525;
      --bg-tertiary: #2d2d2d;
      --text: #e5e5e5;
      --text-dim: #888;
      --accent: #3b82f6;
      --accent-hover: #2563eb;
      --border: #333;
      --green: #22c55e;
      --yellow: #eab308;
      --red: #ef4444;
      --radius: 8px;
      --radius-lg: 12px;
    }

    body {
      font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', sans-serif;
      font-size: 13px;
      color: var(--text);
      background: var(--bg);
      height: 100vh;
      display: flex;
      flex-direction: column;
      -webkit-font-smoothing: antialiased;
    }

    /* Title bar - Mac style */
    .titlebar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 12px 16px;
      background: var(--bg-secondary);
      border-bottom: 1px solid var(--border);
      -webkit-app-region: drag;
    }

    .titlebar-left {
      display: flex;
      align-items: center;
      gap: 10px;
    }

    .status-dot {
      width: 10px;
      height: 10px;
      border-radius: 50%;
      background: var(--green);
      box-shadow: 0 0 6px var(--green);
      transition: all 0.3s;
    }

    .status-dot.disconnected {
      background: var(--red);
      box-shadow: 0 0 6px var(--red);
    }

    .title {
      font-size: 14px;
      font-weight: 600;
      letter-spacing: -0.3px;
    }

    .workspace-badge {
      font-size: 11px;
      color: var(--text-dim);
      background: var(--bg-tertiary);
      padding: 3px 8px;
      border-radius: 4px;
    }

    /* Tab navigation */
    .tabs {
      display: flex;
      background: var(--bg-secondary);
      border-bottom: 1px solid var(--border);
      padding: 0 8px;
    }

    .tab {
      padding: 10px 16px;
      cursor: pointer;
      border: none;
      background: transparent;
      color: var(--text-dim);
      font-size: 12px;
      font-weight: 500;
      transition: all 0.2s;
      border-bottom: 2px solid transparent;
      margin-bottom: -1px;
    }

    .tab:hover { color: var(--text); }
    .tab.active {
      color: var(--text);
      border-bottom-color: var(--accent);
    }

    /* Content areas */
    .content {
      flex: 1;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }

    .tab-content {
      display: none;
      flex: 1;
      flex-direction: column;
      overflow: hidden;
    }

    .tab-content.active { display: flex; }

    .panel {
      flex: 1;
      padding: 16px;
      overflow-y: auto;
    }

    /* Input area */
    .input-area {
      padding: 12px 16px;
      background: var(--bg-secondary);
      border-top: 1px solid var(--border);
    }

    .input-row {
      display: flex;
      gap: 8px;
    }

    textarea {
      flex: 1;
      padding: 10px 12px;
      border: 1px solid var(--border);
      border-radius: var(--radius);
      background: var(--bg);
      color: var(--text);
      font-family: inherit;
      font-size: 13px;
      resize: none;
      min-height: 44px;
      transition: border-color 0.2s;
    }

    textarea:focus {
      outline: none;
      border-color: var(--accent);
    }

    textarea::placeholder { color: var(--text-dim); }

    button {
      padding: 10px 16px;
      border: none;
      border-radius: var(--radius);
      background: var(--accent);
      color: white;
      cursor: pointer;
      font-size: 12px;
      font-weight: 500;
      transition: all 0.2s;
    }

    button:hover { background: var(--accent-hover); }
    button:disabled { opacity: 0.5; cursor: not-allowed; }

    button.ghost {
      background: transparent;
      border: 1px solid var(--border);
      color: var(--text-dim);
    }

    button.ghost:hover {
      background: var(--bg-tertiary);
      color: var(--text);
    }

    button.small {
      padding: 6px 10px;
      font-size: 11px;
    }

    /* Messages */
    .messages {
      display: flex;
      flex-direction: column;
      gap: 12px;
    }

    .message {
      padding: 12px 14px;
      border-radius: var(--radius-lg);
      max-width: 90%;
      line-height: 1.5;
    }

    .message.user {
      background: var(--accent);
      color: white;
      align-self: flex-end;
      border-bottom-right-radius: 4px;
    }

    .message.assistant {
      background: var(--bg-tertiary);
      border: 1px solid var(--border);
      align-self: flex-start;
      border-bottom-left-radius: 4px;
    }

    .message-content {
      white-space: pre-wrap;
      word-break: break-word;
    }

    /* Transcript */
    .transcript-item {
      padding: 12px;
      border-bottom: 1px solid var(--border);
    }

    .transcript-item:last-child { border-bottom: none; }

    .transcript-role {
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      margin-bottom: 6px;
      color: var(--text-dim);
    }

    .transcript-role.user { color: var(--accent); }
    .transcript-role.assistant { color: var(--green); }

    .transcript-content {
      white-space: pre-wrap;
      word-break: break-word;
      line-height: 1.5;
      max-height: 200px;
      overflow-y: auto;
    }

    .transcript-time {
      font-size: 10px;
      color: var(--text-dim);
      margin-top: 6px;
    }

    /* Result card */
    .result-card {
      background: var(--bg-secondary);
      border: 1px solid var(--border);
      border-radius: var(--radius-lg);
      padding: 16px;
    }

    .result-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 12px;
    }

    .result-title {
      font-weight: 600;
      font-size: 14px;
    }

    .result-content {
      background: var(--bg);
      padding: 12px;
      border-radius: var(--radius);
      white-space: pre-wrap;
      font-family: 'SF Mono', Monaco, monospace;
      font-size: 12px;
      line-height: 1.5;
      max-height: 250px;
      overflow-y: auto;
    }

    .meta-list {
      margin-top: 12px;
      padding-left: 20px;
      color: var(--text-dim);
    }

    .meta-list li { margin: 4px 0; }

    /* Empty state */
    .empty-state {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 100%;
      color: var(--text-dim);
      text-align: center;
      gap: 8px;
    }

    .empty-icon {
      font-size: 32px;
      opacity: 0.5;
    }

    /* Loading */
    .loading {
      display: flex;
      align-items: center;
      gap: 8px;
      color: var(--text-dim);
      padding: 12px;
    }

    .spinner {
      width: 14px;
      height: 14px;
      border: 2px solid var(--border);
      border-top-color: var(--accent);
      border-radius: 50%;
      animation: spin 1s linear infinite;
    }

    @keyframes spin { to { transform: rotate(360deg); } }

    /* Error */
    .error {
      background: rgba(239, 68, 68, 0.1);
      border: 1px solid var(--red);
      color: var(--red);
      padding: 12px;
      border-radius: var(--radius);
      font-size: 12px;
    }

    /* Scrollbar */
    ::-webkit-scrollbar { width: 6px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb {
      background: var(--border);
      border-radius: 3px;
    }
    ::-webkit-scrollbar-thumb:hover { background: #444; }
  </style>
</head>
<body>
  <div class="titlebar">
    <div class="titlebar-left">
      <div class="status-dot ${this._isConnected ? '' : 'disconnected'}" id="status-dot" title="${this._isConnected ? 'Connected' : 'Disconnected'}"></div>
      <span class="title">Claude Speak</span>
    </div>
    <span class="workspace-badge">${escapeHtml(workspaceName)}</span>
  </div>

  <div class="tabs">
    <button class="tab ${this._currentTab === 'shaper' ? 'active' : ''}" data-tab="shaper">Shaper</button>
    <button class="tab ${this._currentTab === 'meta' ? 'active' : ''}" data-tab="meta">Meta Engineer</button>
    <button class="tab ${this._currentTab === 'transcript' ? 'active' : ''}" data-tab="transcript">Transcript</button>
  </div>

  <div class="content">
    <!-- Shaper Tab -->
    <div class="tab-content ${this._currentTab === 'shaper' ? 'active' : ''}" id="shaper-tab">
      <div class="panel" id="shaper-panel">
        <div class="empty-state" id="shaper-empty">
          <div class="empty-icon">✨</div>
          <div>Transform your dictated thoughts into structured prompts</div>
        </div>
        <div id="shaper-result" style="display: none;"></div>
        <div id="shaper-loading" class="loading" style="display: none;">
          <div class="spinner"></div>
          <span>Shaping...</span>
        </div>
      </div>
      <div class="input-area">
        <div class="input-row">
          <textarea id="shaper-input" placeholder="Paste your dictation here..." rows="2"></textarea>
          <button id="shape-btn">Shape</button>
        </div>
      </div>
    </div>

    <!-- Meta Engineer Tab -->
    <div class="tab-content ${this._currentTab === 'meta' ? 'active' : ''}" id="meta-tab">
      <div class="panel">
        <div class="messages" id="meta-messages">
          ${this._metaMessages.length === 0 ? `
            <div class="empty-state">
              <div class="empty-icon">🧠</div>
              <div><strong>Meta Engineer</strong></div>
              <div style="font-size: 12px;">Ask questions about your conversation without affecting the main chat</div>
            </div>
          ` : this._metaMessages.map(msg => `
            <div class="message ${msg.role}">
              <div class="message-content">${escapeHtml(msg.content)}</div>
            </div>
          `).join('')}
        </div>
        <div id="meta-loading" class="loading" style="display: none;">
          <div class="spinner"></div>
          <span>Thinking...</span>
        </div>
      </div>
      <div class="input-area">
        <div class="input-row">
          <textarea id="meta-input" placeholder="Ask about your conversation..." rows="2"></textarea>
          <button id="meta-btn">Ask</button>
          <button id="clear-meta-btn" class="ghost small">Clear</button>
        </div>
      </div>
    </div>

    <!-- Transcript Tab -->
    <div class="tab-content ${this._currentTab === 'transcript' ? 'active' : ''}" id="transcript-tab">
      <div class="panel">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
          <span style="font-weight: 500;">Chat Transcript</span>
          <button id="refresh-transcript-btn" class="ghost small">↻ Refresh</button>
        </div>
        <div id="transcript-container">
          ${this._transcript.length === 0 ? `
            <div class="empty-state">
              <div class="empty-icon">💬</div>
              <div>No transcript available</div>
              <div style="font-size: 11px; color: var(--text-dim);">Start a conversation with Claude Code to see it here</div>
            </div>
          ` : this._transcript.map(msg => `
            <div class="transcript-item">
              <div class="transcript-role ${msg.role}">${msg.role === 'user' ? 'You' : 'Claude'}</div>
              <div class="transcript-content">${escapeHtml(msg.content)}</div>
              ${msg.timestamp ? `<div class="transcript-time">${formatTimestamp(msg.timestamp)}</div>` : ''}
            </div>
          `).join('')}
        </div>
      </div>
    </div>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();

    // Tab switching
    document.querySelectorAll('.tab').forEach(tab => {
      tab.addEventListener('click', () => {
        vscode.postMessage({ command: 'switchTab', tab: tab.dataset.tab });
      });
    });

    // Shaper
    const shaperInput = document.getElementById('shaper-input');
    const shapeBtn = document.getElementById('shape-btn');
    const shaperEmpty = document.getElementById('shaper-empty');
    const shaperResult = document.getElementById('shaper-result');
    const shaperLoading = document.getElementById('shaper-loading');

    shapeBtn.addEventListener('click', () => {
      const text = shaperInput.value.trim();
      if (text) vscode.postMessage({ command: 'shapePrompt', text });
    });

    shaperInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) shapeBtn.click();
    });

    // Meta Engineer
    const metaInput = document.getElementById('meta-input');
    const metaBtn = document.getElementById('meta-btn');
    const clearMetaBtn = document.getElementById('clear-meta-btn');
    const metaMessages = document.getElementById('meta-messages');
    const metaLoading = document.getElementById('meta-loading');

    metaBtn.addEventListener('click', () => {
      const text = metaInput.value.trim();
      if (text) {
        metaInput.value = '';
        vscode.postMessage({ command: 'metaQuery', text });
      }
    });

    metaInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) metaBtn.click();
    });

    clearMetaBtn.addEventListener('click', () => {
      vscode.postMessage({ command: 'clearMetaHistory' });
    });

    // Transcript
    const refreshTranscriptBtn = document.getElementById('refresh-transcript-btn');
    refreshTranscriptBtn?.addEventListener('click', () => {
      vscode.postMessage({ command: 'refreshTranscript' });
    });

    // Status dot click to refresh
    document.getElementById('status-dot').addEventListener('click', () => {
      vscode.postMessage({ command: 'refreshConnection' });
    });

    // Handle messages
    window.addEventListener('message', event => {
      const message = event.data;
      switch (message.command) {
        case 'loading':
          shaperLoading.style.display = message.loading ? 'flex' : 'none';
          metaLoading.style.display = message.loading ? 'flex' : 'none';
          shapeBtn.disabled = message.loading;
          metaBtn.disabled = message.loading;
          break;
        case 'shapeResult':
          shaperEmpty.style.display = 'none';
          shaperResult.style.display = 'block';
          shaperResult.innerHTML = \`
            <div class="result-card">
              <div class="result-header">
                <span class="result-title">\${escapeHtml(message.result.title)}</span>
                <button class="small" onclick="copyResult()">Copy</button>
              </div>
              <div class="result-content" id="shaped-prompt">\${escapeHtml(message.result.send_to_claude)}</div>
              \${message.result.assumptions.length > 0 ? \`
                <div style="margin-top: 12px; font-size: 12px;">
                  <strong>Assumptions:</strong>
                  <ul class="meta-list">\${message.result.assumptions.map(a => \`<li>\${escapeHtml(a)}</li>\`).join('')}</ul>
                </div>
              \` : ''}
              \${message.result.questions.length > 0 ? \`
                <div style="margin-top: 12px; font-size: 12px;">
                  <strong>Questions:</strong>
                  <ul class="meta-list">\${message.result.questions.map(q => \`<li>\${escapeHtml(q)}</li>\`).join('')}</ul>
                </div>
              \` : ''}
            </div>
          \`;
          shaperInput.value = '';
          break;
        case 'error':
          shaperEmpty.style.display = 'none';
          shaperResult.style.display = 'block';
          shaperResult.innerHTML = \`<div class="error">\${escapeHtml(message.message)}</div>\`;
          break;
      }
    });

    function copyResult() {
      const prompt = document.getElementById('shaped-prompt')?.textContent || '';
      vscode.postMessage({ command: 'copyToClipboard', text: prompt });
    }

    function escapeHtml(text) {
      const div = document.createElement('div');
      div.textContent = text;
      return div.innerHTML;
    }

    // Scroll to bottom
    if (metaMessages) metaMessages.scrollTop = metaMessages.scrollHeight;
  </script>
</body>
</html>`;
  }
}

// ============================================================================
// Helpers
// ============================================================================

function getNonce() {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function formatTimestamp(ts: string): string {
  try {
    const date = new Date(ts);
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

function buildPayload(
  workspace: string,
  assistantMessages: string[],
  userMessages: string[],
  dictation: string
): string {
  const sections: string[] = [];
  sections.push(`WORKSPACE: ${workspace}\n`);

  if (assistantMessages.length > 0) {
    sections.push('RECENT ASSISTANT MESSAGES:');
    assistantMessages.forEach((msg, i) => {
      sections.push(`[${i + 1}] ${msg.slice(0, 2000)}`);
    });
    sections.push('');
  }

  if (userMessages.length > 0) {
    sections.push('RECENT USER MESSAGES:');
    userMessages.forEach((msg, i) => {
      sections.push(`[${i + 1}] ${msg.slice(0, 1000)}`);
    });
    sections.push('');
  }

  sections.push('RAW DICTATION:');
  sections.push(dictation);

  return sections.join('\n');
}

// ============================================================================
// Extension Lifecycle
// ============================================================================

export function activate(context: vscode.ExtensionContext): void {
  const openPanelCommand = vscode.commands.registerCommand(
    'promptShaper.openPanel',
    () => PromptShaperPanel.createOrShow(context.extensionUri)
  );

  context.subscriptions.push(openPanelCommand);
  console.log('Claude Speak extension activated');
}

export function deactivate(): void {
  cachedCliConfig = null;
}

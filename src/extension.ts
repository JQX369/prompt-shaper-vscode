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
  // Claude Code encodes paths by replacing / and spaces with -
  return workspacePath.replace(/[\/\s]+/g, '-');
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

  // Try exact match first
  const encodedPath = encodeWorkspacePath(workspaceRoot);
  const exactDir = path.join(projectsPath, encodedPath);

  if (fs.existsSync(exactDir)) {
    const filesInDir = await findJsonlFilesInDir(exactDir);
    if (filesInDir.length > 0) {
      filesInDir.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
      return filesInDir[0].path;
    }
  }

  // Try parent directory (useful when Extension Dev Host opens subfolder)
  const parentDir = path.dirname(workspaceRoot);
  if (parentDir !== workspaceRoot) {
    const encodedParent = encodeWorkspacePath(parentDir);
    const parentSessionDir = path.join(projectsPath, encodedParent);

    if (fs.existsSync(parentSessionDir)) {
      const filesInDir = await findJsonlFilesInDir(parentSessionDir);
      if (filesInDir.length > 0) {
        filesInDir.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
        return filesInDir[0].path;
      }
    }
  }

  // Fallback: search all jsonl files and score them
  const allJsonlFiles = await findAllJsonlFiles(projectsPath);

  if (allJsonlFiles.length === 0) {
    return null;
  }

  const workspaceBasename = path.basename(workspaceRoot).toLowerCase();
  const parentBasename = path.basename(path.dirname(workspaceRoot)).toLowerCase();

  const scored = allJsonlFiles.map(file => {
    let score = 0;
    const filePath = file.path.toLowerCase();
    const encodedLower = encodedPath.toLowerCase();

    // Exact workspace match
    if (filePath.includes(encodedLower)) {
      score += 100;
    }

    // Parent directory match (for subfolder scenarios)
    if (parentBasename && filePath.includes(parentBasename)) {
      score += 75;
    }

    // Basename match
    if (filePath.includes(workspaceBasename)) {
      score += 50;
    }

    // Recency bonus
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

      // Format 1: { type: 'user'|'assistant', message: { content: [...] } }
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
      // Format 2: { role: 'user'|'assistant', content: ... }
      else if (obj.role === 'user' || obj.role === 'assistant') {
        role = obj.role;
        msgContent = extractContent(obj.content);
        timestamp = obj.timestamp;
      }
      // Format 3: { message: { role: ..., content: ... } }
      else if (obj.message?.role === 'user' || obj.message?.role === 'assistant') {
        role = obj.message.role;
        msgContent = extractContent(obj.message.content);
        timestamp = obj.timestamp;
      }
      // Format 4: Summary messages
      else if (obj.type === 'summary' && obj.summary) {
        role = 'assistant';
        msgContent = `[Summary] ${obj.summary}`;
        timestamp = obj.timestamp;
      }

      if (role && msgContent && msgContent.trim()) {
        messages.push({ role, content: msgContent.trim(), timestamp });
      }
    } catch {
      // Skip malformed lines
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
        if (item?.type === 'tool_use' && item?.name) {
          // Format tool use for display
          return `[Tool: ${item.name}]`;
        }
        if (item?.type === 'tool_result' && item?.content) {
          const resultContent = extractContent(item.content);
          return resultContent ? `[Tool Result]\n${resultContent.slice(0, 500)}${resultContent.length > 500 ? '...' : ''}` : null;
        }
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
  private _fileWatcher: fs.FSWatcher | null = null;
  private _lastSessionMtime: number = 0;

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

    // Show initial UI immediately, then load data
    this._update();

    // Initialize session and preload transcript (will call _update again when ready)
    this._initializeAndPreload();

    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

    this._panel.webview.onDidReceiveMessage(
      async (message) => {
        switch (message.command) {
          case 'switchTab':
            this._currentTab = message.tab;
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

  private async _initializeAndPreload() {
    // Run initialization and transcript loading in parallel for speed
    const workspaceRoot = getActiveWorkspaceRoot();
    if (!workspaceRoot) {
      this._isConnected = false;
      this._sessionFile = null;
      this._transcript = [];
      return;
    }

    // Find session file once
    this._sessionFile = await findBestSessionFile(workspaceRoot);
    this._isConnected = this._sessionFile !== null && isClaudeCliInstalled();

    // Preload transcript immediately if we have a session
    if (this._sessionFile) {
      // Await the load so UI shows data on first render
      await this._loadTranscriptFromFile(this._sessionFile);
      // Track mtime for change detection
      try {
        const stat = await fs.promises.stat(this._sessionFile);
        this._lastSessionMtime = stat.mtimeMs;
      } catch { /* ignore */ }
    }

    // Set up file watcher on the projects directory to detect session changes
    this._setupFileWatcher(workspaceRoot);
  }

  private _setupFileWatcher(workspaceRoot: string) {
    // Clean up existing watcher
    if (this._fileWatcher) {
      this._fileWatcher.close();
      this._fileWatcher = null;
    }

    const projectsPath = getClaudeProjectsPath();
    if (!fs.existsSync(projectsPath)) return;

    // Watch the projects directory for changes
    try {
      this._fileWatcher = fs.watch(projectsPath, { recursive: true }, async (eventType, filename) => {
        if (!filename || !filename.endsWith('.jsonl')) return;

        // Debounce - check if a new session file is more recent
        const newSessionFile = await findBestSessionFile(workspaceRoot);
        if (newSessionFile && newSessionFile !== this._sessionFile) {
          // Session changed - reload
          this._sessionFile = newSessionFile;
          this._loadTranscriptFromFile(newSessionFile);
        } else if (newSessionFile === this._sessionFile && this._sessionFile) {
          // Same session but file changed - check mtime
          try {
            const stat = await fs.promises.stat(this._sessionFile);
            if (stat.mtimeMs > this._lastSessionMtime + 1000) { // 1s debounce
              this._lastSessionMtime = stat.mtimeMs;
              this._loadTranscriptFromFile(this._sessionFile);
            }
          } catch { /* ignore */ }
        }
      });
    } catch { /* ignore watch errors */ }
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

    // Also refresh transcript when connection is refreshed
    if (this._sessionFile) {
      await this._loadTranscriptFromFile(this._sessionFile);
      this._update();
    }
  }

  private async _loadTranscript() {
    if (this._sessionFile) {
      await this._loadTranscriptFromFile(this._sessionFile);
    } else {
      // Try to find session file again
      const workspaceRoot = getActiveWorkspaceRoot();
      if (workspaceRoot) {
        this._sessionFile = await findBestSessionFile(workspaceRoot);
        if (this._sessionFile) {
          await this._loadTranscriptFromFile(this._sessionFile);
        }
      }
    }
  }

  private async _loadTranscriptFromFile(sessionFile: string) {
    try {
      // Only read last 500KB for transcript display - much faster for large files
      const content = await tailReadFile(sessionFile, 500000);
      const messages = parseJsonlMessages(content);
      this._transcript = messages.map(m => ({
        role: m.role,
        content: m.content,
        timestamp: m.timestamp || '',
      }));
      // Update UI after loading
      this._update();
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
    // Clean up file watcher
    if (this._fileWatcher) {
      this._fileWatcher.close();
      this._fileWatcher = null;
    }
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
      --bg: #1c1c1e;
      --bg-secondary: #2c2c2e;
      --bg-tertiary: #3a3a3c;
      --bg-elevated: #48484a;
      --text: #f5f5f7;
      --text-secondary: #a1a1a6;
      --text-dim: #6e6e73;
      --accent: #0a84ff;
      --accent-hover: #409cff;
      --accent-glow: rgba(10, 132, 255, 0.3);
      --border: rgba(255, 255, 255, 0.1);
      --border-strong: rgba(255, 255, 255, 0.15);
      --green: #30d158;
      --green-glow: rgba(48, 209, 88, 0.4);
      --yellow: #ffd60a;
      --red: #ff453a;
      --purple: #bf5af2;
      --radius: 10px;
      --radius-lg: 14px;
      --shadow: 0 4px 24px rgba(0, 0, 0, 0.4);
      --shadow-sm: 0 2px 8px rgba(0, 0, 0, 0.3);
    }

    body {
      font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Display', 'SF Pro Text', system-ui, sans-serif;
      font-size: 13px;
      color: var(--text);
      background: var(--bg);
      height: 100vh;
      display: flex;
      flex-direction: column;
      -webkit-font-smoothing: antialiased;
      -moz-osx-font-smoothing: grayscale;
    }

    /* Title bar - Mac style with vibrancy effect */
    .titlebar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 14px 18px;
      background: linear-gradient(180deg, var(--bg-secondary) 0%, rgba(44, 44, 46, 0.95) 100%);
      border-bottom: 1px solid var(--border);
      backdrop-filter: blur(20px);
      -webkit-backdrop-filter: blur(20px);
    }

    .titlebar-left {
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .status-indicator {
      display: flex;
      align-items: center;
      gap: 8px;
      cursor: pointer;
      padding: 4px 8px;
      border-radius: 6px;
      transition: background 0.2s;
    }

    .status-indicator:hover {
      background: var(--bg-tertiary);
    }

    .status-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--green);
      box-shadow: 0 0 8px var(--green-glow), 0 0 12px var(--green-glow);
      animation: pulse 2s ease-in-out infinite;
      transition: all 0.3s ease;
    }

    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.7; }
    }

    .status-dot.disconnected {
      background: var(--red);
      box-shadow: 0 0 8px rgba(255, 69, 58, 0.4);
      animation: none;
    }

    .status-text {
      font-size: 11px;
      color: var(--text-secondary);
      font-weight: 500;
    }

    .title {
      font-size: 15px;
      font-weight: 600;
      letter-spacing: -0.4px;
      background: linear-gradient(135deg, var(--text) 0%, var(--text-secondary) 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
    }

    .workspace-badge {
      font-size: 11px;
      color: var(--text-secondary);
      background: var(--bg-tertiary);
      padding: 5px 10px;
      border-radius: 6px;
      border: 1px solid var(--border);
      font-weight: 500;
      max-width: 180px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    /* Tab navigation - pill style */
    .tabs {
      display: flex;
      background: var(--bg-secondary);
      border-bottom: 1px solid var(--border);
      padding: 10px 12px;
      gap: 6px;
    }

    .tab {
      padding: 8px 16px;
      cursor: pointer;
      border: none;
      background: transparent;
      color: var(--text-secondary);
      font-size: 12px;
      font-weight: 500;
      transition: all 0.2s ease;
      border-radius: 8px;
      position: relative;
    }

    .tab:hover {
      color: var(--text);
      background: var(--bg-tertiary);
    }

    .tab.active {
      color: var(--text);
      background: var(--bg-tertiary);
      box-shadow: var(--shadow-sm);
    }

    .tab.active::after {
      content: '';
      position: absolute;
      bottom: -10px;
      left: 50%;
      transform: translateX(-50%);
      width: 20px;
      height: 2px;
      background: var(--accent);
      border-radius: 1px;
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

    /* Input area - floating style */
    .input-area {
      padding: 12px 16px 16px;
      background: linear-gradient(180deg, transparent 0%, var(--bg-secondary) 30%);
    }

    .input-container {
      background: var(--bg-tertiary);
      border: 1px solid var(--border-strong);
      border-radius: var(--radius-lg);
      padding: 4px;
      box-shadow: var(--shadow-sm);
      transition: border-color 0.2s, box-shadow 0.2s;
    }

    .input-container:focus-within {
      border-color: var(--accent);
      box-shadow: 0 0 0 3px var(--accent-glow), var(--shadow-sm);
    }

    .input-row {
      display: flex;
      gap: 8px;
      align-items: flex-end;
    }

    textarea {
      flex: 1;
      padding: 12px 14px;
      border: none;
      border-radius: var(--radius);
      background: transparent;
      color: var(--text);
      font-family: inherit;
      font-size: 14px;
      resize: none;
      min-height: 44px;
      max-height: 120px;
      line-height: 1.4;
    }

    textarea:focus {
      outline: none;
    }

    textarea::placeholder {
      color: var(--text-dim);
    }

    button {
      padding: 10px 18px;
      border: none;
      border-radius: var(--radius);
      background: var(--accent);
      color: white;
      cursor: pointer;
      font-size: 13px;
      font-weight: 600;
      transition: all 0.2s ease;
      white-space: nowrap;
    }

    button:hover {
      background: var(--accent-hover);
      transform: translateY(-1px);
    }

    button:active {
      transform: translateY(0);
    }

    button:disabled {
      opacity: 0.5;
      cursor: not-allowed;
      transform: none;
    }

    button.ghost {
      background: var(--bg-elevated);
      border: 1px solid var(--border);
      color: var(--text-secondary);
    }

    button.ghost:hover {
      background: var(--bg-tertiary);
      color: var(--text);
      border-color: var(--border-strong);
    }

    button.small {
      padding: 6px 12px;
      font-size: 11px;
      font-weight: 500;
    }

    /* Messages - chat bubble style */
    .messages {
      display: flex;
      flex-direction: column;
      gap: 16px;
      padding-bottom: 8px;
    }

    .message {
      max-width: 85%;
      animation: messageIn 0.3s ease-out;
    }

    @keyframes messageIn {
      from {
        opacity: 0;
        transform: translateY(10px);
      }
      to {
        opacity: 1;
        transform: translateY(0);
      }
    }

    .message.user {
      align-self: flex-end;
    }

    .message.assistant {
      align-self: flex-start;
    }

    .message-bubble {
      padding: 12px 16px;
      border-radius: 18px;
      line-height: 1.5;
    }

    .message.user .message-bubble {
      background: var(--accent);
      color: white;
      border-bottom-right-radius: 6px;
    }

    .message.assistant .message-bubble {
      background: var(--bg-tertiary);
      border: 1px solid var(--border);
      border-bottom-left-radius: 6px;
    }

    .message-content {
      white-space: pre-wrap;
      word-break: break-word;
    }

    .message-time {
      font-size: 10px;
      color: var(--text-dim);
      margin-top: 4px;
      padding: 0 4px;
    }

    .message.user .message-time {
      text-align: right;
    }

    /* Typing indicator */
    .typing-indicator {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 16px;
      animation: messageIn 0.3s ease-out;
    }

    .typing-avatar {
      width: 32px;
      height: 32px;
      border-radius: 50%;
      background: linear-gradient(135deg, var(--purple) 0%, var(--accent) 100%);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 14px;
    }

    .typing-bubble {
      background: var(--bg-tertiary);
      border: 1px solid var(--border);
      padding: 14px 18px;
      border-radius: 18px;
      border-bottom-left-radius: 6px;
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .typing-dot {
      width: 8px;
      height: 8px;
      background: var(--text-dim);
      border-radius: 50%;
      animation: typingBounce 1.4s ease-in-out infinite;
    }

    .typing-dot:nth-child(2) { animation-delay: 0.2s; }
    .typing-dot:nth-child(3) { animation-delay: 0.4s; }

    @keyframes typingBounce {
      0%, 60%, 100% { transform: translateY(0); }
      30% { transform: translateY(-6px); }
    }

    /* Transcript */
    .transcript-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 16px;
      padding-bottom: 12px;
      border-bottom: 1px solid var(--border);
    }

    .transcript-title {
      font-weight: 600;
      font-size: 14px;
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .transcript-count {
      font-size: 11px;
      color: var(--text-dim);
      background: var(--bg-tertiary);
      padding: 2px 8px;
      border-radius: 10px;
    }

    .transcript-list {
      display: flex;
      flex-direction: column;
      gap: 2px;
    }

    .transcript-item {
      padding: 14px 16px;
      border-radius: var(--radius);
      background: var(--bg-secondary);
      border: 1px solid var(--border);
      transition: all 0.2s;
    }

    .transcript-item:hover {
      background: var(--bg-tertiary);
      border-color: var(--border-strong);
    }

    .transcript-item-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 8px;
    }

    .transcript-role {
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      padding: 3px 8px;
      border-radius: 4px;
    }

    .transcript-role.user {
      color: var(--accent);
      background: rgba(10, 132, 255, 0.15);
    }

    .transcript-role.assistant {
      color: var(--green);
      background: rgba(48, 209, 88, 0.15);
    }

    .transcript-time {
      font-size: 10px;
      color: var(--text-dim);
    }

    .transcript-content {
      white-space: pre-wrap;
      word-break: break-word;
      line-height: 1.5;
      max-height: 150px;
      overflow-y: auto;
      font-size: 13px;
      color: var(--text-secondary);
    }

    /* Result card */
    .result-card {
      background: var(--bg-secondary);
      border: 1px solid var(--border);
      border-radius: var(--radius-lg);
      padding: 18px;
      box-shadow: var(--shadow-sm);
      animation: messageIn 0.3s ease-out;
    }

    .result-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 14px;
      padding-bottom: 12px;
      border-bottom: 1px solid var(--border);
    }

    .result-title {
      font-weight: 600;
      font-size: 15px;
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .result-title::before {
      content: '✨';
    }

    .result-content {
      background: var(--bg);
      padding: 14px 16px;
      border-radius: var(--radius);
      white-space: pre-wrap;
      font-family: 'SF Mono', 'Fira Code', Monaco, monospace;
      font-size: 12px;
      line-height: 1.6;
      max-height: 280px;
      overflow-y: auto;
      border: 1px solid var(--border);
    }

    .meta-section {
      margin-top: 14px;
      padding-top: 14px;
      border-top: 1px solid var(--border);
    }

    .meta-section-title {
      font-size: 12px;
      font-weight: 600;
      color: var(--text-secondary);
      margin-bottom: 8px;
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .meta-list {
      padding-left: 18px;
      color: var(--text-secondary);
      font-size: 12px;
    }

    .meta-list li {
      margin: 6px 0;
      line-height: 1.4;
    }

    /* Empty state */
    .empty-state {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 100%;
      color: var(--text-dim);
      text-align: center;
      gap: 12px;
      padding: 40px;
    }

    .empty-icon {
      font-size: 48px;
      opacity: 0.6;
      margin-bottom: 8px;
    }

    .empty-title {
      font-size: 16px;
      font-weight: 600;
      color: var(--text-secondary);
    }

    .empty-subtitle {
      font-size: 13px;
      color: var(--text-dim);
      max-width: 280px;
      line-height: 1.5;
    }

    /* Loading state in messages */
    .loading-inline {
      display: none;
      padding: 16px;
    }

    .loading-inline.active {
      display: block;
    }

    /* Error */
    .error {
      background: rgba(255, 69, 58, 0.1);
      border: 1px solid rgba(255, 69, 58, 0.3);
      color: var(--red);
      padding: 14px 16px;
      border-radius: var(--radius);
      font-size: 13px;
      display: flex;
      align-items: center;
      gap: 10px;
      animation: messageIn 0.3s ease-out;
    }

    .error::before {
      content: '⚠️';
    }

    /* Scrollbar - refined */
    ::-webkit-scrollbar {
      width: 8px;
      height: 8px;
    }

    ::-webkit-scrollbar-track {
      background: transparent;
    }

    ::-webkit-scrollbar-thumb {
      background: var(--bg-elevated);
      border-radius: 4px;
      border: 2px solid transparent;
      background-clip: padding-box;
    }

    ::-webkit-scrollbar-thumb:hover {
      background: var(--text-dim);
      border: 2px solid transparent;
      background-clip: padding-box;
    }

    /* Keyboard hint */
    .keyboard-hint {
      font-size: 10px;
      color: var(--text-dim);
      margin-top: 8px;
      text-align: center;
    }

    kbd {
      background: var(--bg-tertiary);
      padding: 2px 6px;
      border-radius: 4px;
      font-family: inherit;
      font-size: 10px;
      border: 1px solid var(--border);
    }
  </style>
</head>
<body>
  <div class="titlebar">
    <div class="titlebar-left">
      <div class="status-indicator" id="status-indicator" title="Click to refresh connection">
        <div class="status-dot ${this._isConnected ? '' : 'disconnected'}"></div>
        <span class="status-text">${this._isConnected ? 'Connected' : 'Disconnected'}</span>
      </div>
      <span class="title">Claude Speak</span>
    </div>
    <span class="workspace-badge" title="${escapeHtml(workspaceName)}">${escapeHtml(workspaceName)}</span>
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
          <div class="empty-title">Prompt Shaper</div>
          <div class="empty-subtitle">Transform your messy dictated thoughts into structured, send-ready prompts for Claude</div>
        </div>
        <div id="shaper-result" style="display: none;"></div>
        <div id="shaper-loading" class="typing-indicator" style="display: none;">
          <div class="typing-avatar">✨</div>
          <div class="typing-bubble">
            <div class="typing-dot"></div>
            <div class="typing-dot"></div>
            <div class="typing-dot"></div>
          </div>
        </div>
      </div>
      <div class="input-area">
        <div class="input-container">
          <div class="input-row">
            <textarea id="shaper-input" placeholder="Paste your dictation here..." rows="2"></textarea>
            <button id="shape-btn">Shape</button>
          </div>
        </div>
        <div class="keyboard-hint"><kbd>⌘</kbd> + <kbd>Enter</kbd> to send</div>
      </div>
    </div>

    <!-- Meta Engineer Tab -->
    <div class="tab-content ${this._currentTab === 'meta' ? 'active' : ''}" id="meta-tab">
      <div class="panel" id="meta-panel">
        <div class="messages" id="meta-messages">
          ${this._metaMessages.length === 0 ? `
            <div class="empty-state">
              <div class="empty-icon">🧠</div>
              <div class="empty-title">Meta Engineer</div>
              <div class="empty-subtitle">A side-channel for reflecting on your conversation without affecting the main Claude Code chat</div>
            </div>
          ` : this._metaMessages.map(msg => `
            <div class="message ${msg.role}">
              <div class="message-bubble">
                <div class="message-content">${escapeHtml(msg.content)}</div>
              </div>
              <div class="message-time">${formatTime(msg.timestamp)}</div>
            </div>
          `).join('')}
        </div>
        <div id="meta-loading" class="typing-indicator" style="display: none;">
          <div class="typing-avatar">🧠</div>
          <div class="typing-bubble">
            <div class="typing-dot"></div>
            <div class="typing-dot"></div>
            <div class="typing-dot"></div>
          </div>
        </div>
      </div>
      <div class="input-area">
        <div class="input-container">
          <div class="input-row">
            <textarea id="meta-input" placeholder="Ask about your conversation..." rows="2"></textarea>
            <button id="meta-btn">Ask</button>
            <button id="clear-meta-btn" class="ghost small">Clear</button>
          </div>
        </div>
        <div class="keyboard-hint"><kbd>⌘</kbd> + <kbd>Enter</kbd> to send</div>
      </div>
    </div>

    <!-- Transcript Tab -->
    <div class="tab-content ${this._currentTab === 'transcript' ? 'active' : ''}" id="transcript-tab">
      <div class="panel">
        <div class="transcript-header">
          <div class="transcript-title">
            Chat Transcript
            <span class="transcript-count">${this._transcript.length} messages</span>
          </div>
          <button id="refresh-transcript-btn" class="ghost small">↻ Refresh</button>
        </div>
        <div id="transcript-container">
          ${this._transcript.length === 0 ? `
            <div class="empty-state">
              <div class="empty-icon">💬</div>
              <div class="empty-title">No Transcript</div>
              <div class="empty-subtitle">Start a conversation with Claude Code to see it here</div>
            </div>
          ` : `<div class="transcript-list">${this._transcript.map(msg => `
            <div class="transcript-item">
              <div class="transcript-item-header">
                <span class="transcript-role ${msg.role}">${msg.role === 'user' ? 'You' : 'Claude'}</span>
                ${msg.timestamp ? `<span class="transcript-time">${formatTimestamp(msg.timestamp)}</span>` : ''}
              </div>
              <div class="transcript-content">${escapeHtml(msg.content)}</div>
            </div>
          `).join('')}</div>`}
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
    const shaperPanel = document.getElementById('shaper-panel');

    shapeBtn.addEventListener('click', () => {
      const text = shaperInput.value.trim();
      if (text) {
        vscode.postMessage({ command: 'shapePrompt', text });
      }
    });

    shaperInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        shapeBtn.click();
      }
    });

    // Auto-resize textarea
    shaperInput.addEventListener('input', () => {
      shaperInput.style.height = 'auto';
      shaperInput.style.height = Math.min(shaperInput.scrollHeight, 120) + 'px';
    });

    // Meta Engineer
    const metaInput = document.getElementById('meta-input');
    const metaBtn = document.getElementById('meta-btn');
    const clearMetaBtn = document.getElementById('clear-meta-btn');
    const metaMessages = document.getElementById('meta-messages');
    const metaLoading = document.getElementById('meta-loading');
    const metaPanel = document.getElementById('meta-panel');

    metaBtn.addEventListener('click', () => {
      const text = metaInput.value.trim();
      if (text) {
        metaInput.value = '';
        metaInput.style.height = 'auto';
        vscode.postMessage({ command: 'metaQuery', text });
      }
    });

    metaInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        metaBtn.click();
      }
    });

    metaInput.addEventListener('input', () => {
      metaInput.style.height = 'auto';
      metaInput.style.height = Math.min(metaInput.scrollHeight, 120) + 'px';
    });

    clearMetaBtn.addEventListener('click', () => {
      vscode.postMessage({ command: 'clearMetaHistory' });
    });

    // Transcript
    const refreshTranscriptBtn = document.getElementById('refresh-transcript-btn');
    refreshTranscriptBtn?.addEventListener('click', () => {
      vscode.postMessage({ command: 'refreshTranscript' });
    });

    // Status indicator click to refresh
    document.getElementById('status-indicator')?.addEventListener('click', () => {
      vscode.postMessage({ command: 'refreshConnection' });
    });

    // Handle messages from extension
    window.addEventListener('message', event => {
      const message = event.data;
      switch (message.command) {
        case 'loading':
          if (shaperLoading) shaperLoading.style.display = message.loading ? 'flex' : 'none';
          if (metaLoading) metaLoading.style.display = message.loading ? 'flex' : 'none';
          if (shapeBtn) shapeBtn.disabled = message.loading;
          if (metaBtn) metaBtn.disabled = message.loading;
          // Scroll to show loading indicator
          if (message.loading) {
            if (shaperPanel) shaperPanel.scrollTop = shaperPanel.scrollHeight;
            if (metaPanel) metaPanel.scrollTop = metaPanel.scrollHeight;
          }
          break;
        case 'shapeResult':
          if (shaperEmpty) shaperEmpty.style.display = 'none';
          if (shaperResult) {
            shaperResult.style.display = 'block';
            shaperResult.innerHTML = \`
              <div class="result-card">
                <div class="result-header">
                  <span class="result-title">\${escapeHtml(message.result.title)}</span>
                  <button class="small" onclick="copyResult()">Copy</button>
                </div>
                <div class="result-content" id="shaped-prompt">\${escapeHtml(message.result.send_to_claude)}</div>
                \${message.result.assumptions.length > 0 ? \`
                  <div class="meta-section">
                    <div class="meta-section-title">💡 Assumptions</div>
                    <ul class="meta-list">\${message.result.assumptions.map(a => \`<li>\${escapeHtml(a)}</li>\`).join('')}</ul>
                  </div>
                \` : ''}
                \${message.result.questions.length > 0 ? \`
                  <div class="meta-section">
                    <div class="meta-section-title">❓ Questions to clarify</div>
                    <ul class="meta-list">\${message.result.questions.map(q => \`<li>\${escapeHtml(q)}</li>\`).join('')}</ul>
                  </div>
                \` : ''}
              </div>
            \`;
          }
          if (shaperInput) shaperInput.value = '';
          break;
        case 'error':
          if (shaperEmpty) shaperEmpty.style.display = 'none';
          if (shaperResult) {
            shaperResult.style.display = 'block';
            shaperResult.innerHTML = \`<div class="error">\${escapeHtml(message.message)}</div>\`;
          }
          break;
      }
    });

    function copyResult() {
      const prompt = document.getElementById('shaped-prompt')?.textContent || '';
      vscode.postMessage({ command: 'copyToClipboard', text: prompt });
    }

    function escapeHtml(text) {
      if (!text) return '';
      const div = document.createElement('div');
      div.textContent = text;
      return div.innerHTML;
    }

    // Scroll to bottom on load
    function scrollToBottom() {
      if (metaPanel) {
        metaPanel.scrollTop = metaPanel.scrollHeight;
      }
    }

    // Initial scroll
    scrollToBottom();

    // Focus input based on active tab
    const activeTab = document.querySelector('.tab.active');
    if (activeTab?.dataset.tab === 'shaper' && shaperInput) {
      shaperInput.focus();
    } else if (activeTab?.dataset.tab === 'meta' && metaInput) {
      metaInput.focus();
    }
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

function formatTime(ts: number): string {
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
// Quick Popup Shape Command
// ============================================================================

async function quickDictateAndShape(): Promise<void> {
  const workspaceRoot = getActiveWorkspaceRoot();
  if (!workspaceRoot) {
    vscode.window.showErrorMessage('No workspace folder open.');
    return;
  }

  if (!isClaudeCliInstalled()) {
    vscode.window.showErrorMessage('Claude CLI not found. Please install it first.');
    return;
  }

  // Get dictation from user
  const dictation = await vscode.window.showInputBox({
    prompt: 'Paste your dictated text',
    placeHolder: 'Enter your messy dictation here...',
    ignoreFocusOut: true,
  });

  if (!dictation || !dictation.trim()) {
    return;
  }

  // Show progress
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'Shaping your prompt...',
      cancellable: false,
    },
    async () => {
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
          } catch { /* ignore */ }
        }

        const payload = buildPayload(workspaceRoot, assistantMessages, userMessages, dictation);
        const rawOutput = await invokeClaudeCli(payload, SYSTEM_PROMPT);
        const shaped = parseShapeOutput(rawOutput);

        // Show result in quick pick
        const action = await vscode.window.showQuickPick(
          [
            { label: '$(clippy) Copy to Clipboard', action: 'copy' },
            { label: '$(eye) View Full Result', action: 'view' },
            { label: '$(close) Dismiss', action: 'dismiss' },
          ],
          {
            title: `✨ ${shaped.title}`,
            placeHolder: shaped.send_to_claude.slice(0, 100) + '...',
          }
        );

        if (action?.action === 'copy') {
          await vscode.env.clipboard.writeText(shaped.send_to_claude);
          vscode.window.showInformationMessage('Shaped prompt copied to clipboard!');
        } else if (action?.action === 'view') {
          // Show in output channel
          const channel = vscode.window.createOutputChannel('Claude Speak');
          channel.clear();
          channel.appendLine(`✨ ${shaped.title}`);
          channel.appendLine('─'.repeat(50));
          channel.appendLine('');
          channel.appendLine('SHAPED PROMPT:');
          channel.appendLine(shaped.send_to_claude);
          if (shaped.assumptions.length > 0) {
            channel.appendLine('');
            channel.appendLine('ASSUMPTIONS:');
            shaped.assumptions.forEach(a => channel.appendLine(`• ${a}`));
          }
          if (shaped.questions.length > 0) {
            channel.appendLine('');
            channel.appendLine('QUESTIONS TO CLARIFY:');
            shaped.questions.forEach(q => channel.appendLine(`• ${q}`));
          }
          channel.show();
        }
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(`Claude Speak failed: ${errorMsg}`);
      }
    }
  );
}

// ============================================================================
// Extension Lifecycle
// ============================================================================

export function activate(context: vscode.ExtensionContext): void {
  const openPanelCommand = vscode.commands.registerCommand(
    'promptShaper.openPanel',
    () => PromptShaperPanel.createOrShow(context.extensionUri)
  );

  const quickShapeCommand = vscode.commands.registerCommand(
    'promptShaper.dictateAndShape',
    quickDictateAndShape
  );

  context.subscriptions.push(openPanelCommand, quickShapeCommand);
  console.log('Claude Speak extension activated');
}

export function deactivate(): void {
  cachedCliConfig = null;
}

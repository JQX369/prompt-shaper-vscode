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
  timestamp?: number;
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
// Claude Code Session Discovery
// ============================================================================

function getClaudeProjectsPath(): string {
  const home = os.homedir();
  return path.join(home, '.claude', 'projects');
}

function encodeWorkspacePath(workspacePath: string): string {
  return workspacePath.replace(/\//g, '-').replace(/^-/, '');
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
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        try {
          const stat = await fs.promises.stat(fullPath);
          results.push({ path: fullPath, mtime: stat.mtime });
        } catch {
          // Skip files we can't stat
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

  const allJsonlFiles = await findAllJsonlFiles(projectsPath);

  if (allJsonlFiles.length === 0) {
    return null;
  }

  const encodedPath = encodeWorkspacePath(workspaceRoot);
  const workspaceBasename = path.basename(workspaceRoot);

  const scored = allJsonlFiles.map(file => {
    let score = 0;
    const filePath = file.path.toLowerCase();
    const encodedLower = encodedPath.toLowerCase();
    const basenameLower = workspaceBasename.toLowerCase();

    if (filePath.includes(encodedLower)) {
      score += 100;
    }

    if (filePath.includes(basenameLower)) {
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
// Session Log Parsing (Tail-Read)
// ============================================================================

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

      if (obj.role === 'user' || obj.role === 'assistant') {
        role = obj.role;
        msgContent = extractContent(obj.content);
      }
      else if (obj.type === 'user' || obj.type === 'human') {
        role = 'user';
        msgContent = extractContent(obj.message || obj.content || obj.text);
      }
      else if (obj.type === 'assistant' || obj.type === 'ai') {
        role = 'assistant';
        msgContent = extractContent(obj.message || obj.content || obj.text);
      }
      else if (obj.message?.role) {
        role = obj.message.role === 'user' || obj.message.role === 'human' ? 'user' :
               obj.message.role === 'assistant' || obj.message.role === 'ai' ? 'assistant' : null;
        msgContent = extractContent(obj.message.content);
      }

      if (role && msgContent && msgContent.trim()) {
        messages.push({ role, content: msgContent.trim() });
      }
    } catch {
      // Skip unparseable lines
    }
  }

  return messages;
}

function extractContent(value: unknown): string | null {
  if (typeof value === 'string') {
    return value;
  }
  if (Array.isArray(value)) {
    return value
      .map(item => {
        if (typeof item === 'string') return item;
        if (item?.text) return item.text;
        if (item?.content) return item.content;
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
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
    printFlag: null,
    systemPromptFlag: null,
    systemPromptEnv: null,
  };

  try {
    let helpOutput = '';
    try {
      helpOutput = execSync('claude --help 2>&1', {
        encoding: 'utf-8',
        timeout: 10000,
      });
    } catch (e: unknown) {
      if (e && typeof e === 'object' && 'stdout' in e) {
        helpOutput = String((e as { stdout: unknown }).stdout || '');
      }
    }

    if (!helpOutput) {
      try {
        helpOutput = execSync('claude -h 2>&1', {
          encoding: 'utf-8',
          timeout: 10000,
        });
      } catch (e: unknown) {
        if (e && typeof e === 'object' && 'stdout' in e) {
          helpOutput = String((e as { stdout: unknown }).stdout || '');
        }
      }
    }

    const helpLower = helpOutput.toLowerCase();

    if (helpLower.includes('-p') && (helpLower.includes('print') || helpLower.includes('prompt') || helpLower.includes('non-interactive'))) {
      config.printFlag = '-p';
    } else if (helpLower.includes('--print')) {
      config.printFlag = '--print';
    } else if (helpLower.includes('--prompt')) {
      config.printFlag = '--prompt';
    } else if (helpLower.includes('--non-interactive')) {
      config.printFlag = '--non-interactive';
    } else {
      config.printFlag = '-p';
    }

    if (helpLower.includes('--system-prompt')) {
      config.systemPromptFlag = '--system-prompt';
    } else if (helpLower.includes('--system')) {
      config.systemPromptFlag = '--system';
    } else if (helpLower.includes('-s') && helpLower.includes('system')) {
      config.systemPromptFlag = '-s';
    }

    if (helpLower.includes('claude_system_prompt') || helpLower.includes('system_prompt')) {
      config.systemPromptEnv = 'CLAUDE_SYSTEM_PROMPT';
    }

  } catch {
    config.printFlag = '-p';
  }

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
    }
    else if (cliConfig.systemPromptEnv) {
      env[cliConfig.systemPromptEnv] = systemPrompt;
      args.push(payload);
    }
    else {
      const combinedPayload = `[SYSTEM INSTRUCTIONS]\n${systemPrompt}\n\n[USER REQUEST]\n${payload}`;
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
      if (timedOut) {
        return;
      }
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
        try {
          proc.kill('SIGKILL');
        } catch {
          // Already dead
        }
      }, 1000);
      reject(new Error('Claude CLI timed out after 120 seconds. The model may be slow or unresponsive.'));
    }, 120000);

    proc.on('close', () => {
      clearTimeout(timeout);
    });
  });
}

// ============================================================================
// JSON Parsing (Robust)
// ============================================================================

function parseShapeOutput(raw: string): ShaperOutput {
  let depth = 0;
  let start = -1;
  let end = -1;

  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === '{') {
      if (depth === 0) {
        start = i;
      }
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
    throw new Error('Missing or invalid send_to_claude field');
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
// Dictate and Shape Command
// ============================================================================

async function dictateAndShape(): Promise<void> {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) {
    vscode.window.showErrorMessage(
      'Prompt Shaper: No workspace folder open. Please open a folder first.'
    );
    return;
  }

  const workspaceRoot = workspaceFolders[0].uri.fsPath;

  const projectsPath = getClaudeProjectsPath();
  if (!fs.existsSync(projectsPath)) {
    const platform = os.platform();
    if (platform !== 'darwin') {
      vscode.window.showErrorMessage(
        `Prompt Shaper: Claude Code projects directory not found at ${projectsPath}. ` +
        `This extension is optimized for macOS. On ${platform}, Claude Code may store logs elsewhere.`
      );
    } else {
      vscode.window.showErrorMessage(
        `Prompt Shaper: Claude Code projects directory not found at ${projectsPath}. ` +
        'Please run Claude Code at least once to generate session logs.'
      );
    }
    return;
  }

  if (!isClaudeCliInstalled()) {
    vscode.window.showErrorMessage(
      'Prompt Shaper: Claude CLI not found on PATH. ' +
      'Please install Claude Code CLI: https://docs.anthropic.com/en/docs/claude-code'
    );
    return;
  }

  const dictation = await vscode.window.showInputBox({
    title: 'Prompt Shaper',
    prompt: 'Paste your dictated text here (use OS dictation, then paste)',
    placeHolder: 'I want to add a feature that does...',
    ignoreFocusOut: true,
  });

  if (!dictation || !dictation.trim()) {
    return;
  }

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'Prompt Shaper',
      cancellable: false,
    },
    async (progress) => {
      progress.report({ message: 'Finding session context...' });

      const config = getConfig();

      const sessionFile = await findBestSessionFile(workspaceRoot);
      let assistantMessages: string[] = [];
      let userMessages: string[] = [];

      if (sessionFile) {
        try {
          const content = await tailReadFile(sessionFile, config.maxTailBytes);
          const messages = parseJsonlMessages(content);
          const extracted = extractRecentMessages(
            messages,
            config.maxAssistantMessages,
            config.maxUserMessages
          );
          assistantMessages = extracted.assistantMessages;
          userMessages = extracted.userMessages;
        } catch (err) {
          console.warn('Prompt Shaper: Failed to read session file:', err);
        }
      }

      progress.report({ message: 'Shaping prompt with Claude...' });

      const payload = buildPayload(workspaceRoot, assistantMessages, userMessages, dictation);

      let rawOutput: string;
      try {
        rawOutput = await invokeClaudeCli(payload, SYSTEM_PROMPT);
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(
          `Prompt Shaper: Claude CLI failed. ${errorMsg}\n\n` +
          'Make sure you are logged in: run "claude" in terminal first.'
        );
        return;
      }

      let shaped: ShaperOutput;
      try {
        shaped = parseShapeOutput(rawOutput);
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        console.error('Prompt Shaper raw output:', rawOutput);
        vscode.window.showErrorMessage(
          `Prompt Shaper: Failed to parse Claude output. ${errorMsg}\n\n` +
          'Check Output panel (Prompt Shaper) for raw response.'
        );

        const channel = vscode.window.createOutputChannel('Prompt Shaper');
        channel.appendLine('=== Raw Claude Output ===');
        channel.appendLine(rawOutput);
        channel.show();
        return;
      }

      await vscode.env.clipboard.writeText(shaped.send_to_claude);

      let notification = `Shaped prompt copied to clipboard!`;
      if (shaped.questions.length > 0) {
        notification += ` (${shaped.questions.length} clarifying question${shaped.questions.length > 1 ? 's' : ''} included)`;
      }

      vscode.window.showInformationMessage(notification);

      if (shaped.questions.length > 0 || shaped.assumptions.length > 0) {
        const channel = vscode.window.createOutputChannel('Prompt Shaper');
        channel.clear();
        channel.appendLine(`=== ${shaped.title} ===`);
        channel.appendLine('');
        channel.appendLine('--- SEND TO CLAUDE ---');
        channel.appendLine(shaped.send_to_claude);

        if (shaped.assumptions.length > 0) {
          channel.appendLine('');
          channel.appendLine('--- ASSUMPTIONS ---');
          shaped.assumptions.forEach((a, i) => channel.appendLine(`${i + 1}. ${a}`));
        }

        if (shaped.questions.length > 0) {
          channel.appendLine('');
          channel.appendLine('--- QUESTIONS (needs clarification) ---');
          shaped.questions.forEach((q, i) => channel.appendLine(`${i + 1}. ${q}`));
        }

        channel.appendLine('');
        channel.appendLine('--- ORIGINAL DICTATION ---');
        channel.appendLine(shaped.verbatim);
      }
    }
  );
}

function buildPayload(
  workspace: string,
  assistantMessages: string[],
  userMessages: string[],
  dictation: string
): string {
  const sections: string[] = [];

  sections.push(`WORKSPACE: ${workspace}`);
  sections.push('');

  if (assistantMessages.length > 0) {
    sections.push('RECENT_ASSISTANT_MESSAGES (oldest to newest):');
    assistantMessages.forEach((msg, i) => {
      const truncated = msg.length > 2000 ? msg.slice(0, 2000) + '...[truncated]' : msg;
      sections.push(`[${i + 1}] ${truncated}`);
      sections.push('');
    });
  } else {
    sections.push('RECENT_ASSISTANT_MESSAGES: (none available)');
    sections.push('');
  }

  if (userMessages.length > 0) {
    sections.push('RECENT_USER_MESSAGES (oldest to newest):');
    userMessages.forEach((msg, i) => {
      const truncated = msg.length > 1000 ? msg.slice(0, 1000) + '...[truncated]' : msg;
      sections.push(`[${i + 1}] ${truncated}`);
      sections.push('');
    });
  } else {
    sections.push('RECENT_USER_MESSAGES: (none available)');
    sections.push('');
  }

  sections.push('RAW_DICTATION:');
  sections.push(dictation);

  return sections.join('\n');
}

// ============================================================================
// Meta Engineer Panel
// ============================================================================

class MetaEngineerPanel {
  public static currentPanel: MetaEngineerPanel | undefined;
  private readonly _panel: vscode.WebviewPanel;
  private readonly _extensionUri: vscode.Uri;
  private _disposables: vscode.Disposable[] = [];
  private _messages: MetaEngineerMessage[] = [];
  private _currentTab: 'shaper' | 'meta' = 'shaper';

  public static createOrShow(extensionUri: vscode.Uri) {
    const column = vscode.window.activeTextEditor
      ? vscode.window.activeTextEditor.viewColumn
      : undefined;

    if (MetaEngineerPanel.currentPanel) {
      MetaEngineerPanel.currentPanel._panel.reveal(column);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'promptShaperPanel',
      'Prompt Shaper',
      column || vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [extensionUri],
      }
    );

    MetaEngineerPanel.currentPanel = new MetaEngineerPanel(panel, extensionUri);
  }

  private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
    this._panel = panel;
    this._extensionUri = extensionUri;

    this._update();

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
            this._messages = [];
            this._update();
            break;
        }
      },
      null,
      this._disposables
    );
  }

  private async _handleShapePrompt(dictation: string) {
    if (!dictation.trim()) {
      return;
    }

    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      this._sendError('No workspace folder open. Please open a folder first.');
      return;
    }

    const workspaceRoot = workspaceFolders[0].uri.fsPath;

    if (!isClaudeCliInstalled()) {
      this._sendError('Claude CLI not found on PATH. Please install Claude Code CLI.');
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
          const extracted = extractRecentMessages(
            messages,
            config.maxAssistantMessages,
            config.maxUserMessages
          );
          assistantMessages = extracted.assistantMessages;
          userMessages = extracted.userMessages;
        } catch (err) {
          console.warn('Failed to read session file:', err);
        }
      }

      const payload = buildPayload(workspaceRoot, assistantMessages, userMessages, dictation);
      const rawOutput = await invokeClaudeCli(payload, SYSTEM_PROMPT);
      const shaped = parseShapeOutput(rawOutput);

      this._panel.webview.postMessage({
        command: 'shapeResult',
        result: shaped,
      });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this._sendError(`Failed to shape prompt: ${errorMsg}`);
    } finally {
      this._panel.webview.postMessage({ command: 'loading', loading: false });
    }
  }

  private async _handleMetaQuery(query: string) {
    if (!query.trim()) {
      return;
    }

    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      this._sendError('No workspace folder open. Please open a folder first.');
      return;
    }

    const workspaceRoot = workspaceFolders[0].uri.fsPath;

    if (!isClaudeCliInstalled()) {
      this._sendError('Claude CLI not found on PATH. Please install Claude Code CLI.');
      return;
    }

    // Add user message to history
    this._messages.push({
      role: 'user',
      content: query,
      timestamp: Date.now(),
    });

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
          const extracted = extractRecentMessages(
            messages,
            config.maxAssistantMessages,
            config.maxUserMessages
          );
          assistantMessages = extracted.assistantMessages;
          userMessages = extracted.userMessages;
        } catch (err) {
          console.warn('Failed to read session file:', err);
        }
      }

      // Build context for Meta Engineer
      const contextParts: string[] = [];
      contextParts.push(`WORKSPACE: ${workspaceRoot}`);
      contextParts.push('');
      contextParts.push('=== CURRENT CLAUDE CODE SESSION CONTEXT ===');

      if (userMessages.length > 0) {
        contextParts.push('Recent user messages to Claude:');
        userMessages.forEach((msg, i) => {
          const truncated = msg.length > 1500 ? msg.slice(0, 1500) + '...[truncated]' : msg;
          contextParts.push(`[User ${i + 1}] ${truncated}`);
        });
        contextParts.push('');
      }

      if (assistantMessages.length > 0) {
        contextParts.push('Recent Claude responses:');
        assistantMessages.forEach((msg, i) => {
          const truncated = msg.length > 1500 ? msg.slice(0, 1500) + '...[truncated]' : msg;
          contextParts.push(`[Claude ${i + 1}] ${truncated}`);
        });
        contextParts.push('');
      }

      // Add Meta Engineer conversation history
      if (this._messages.length > 1) {
        contextParts.push('=== META ENGINEER CONVERSATION HISTORY ===');
        const historyToInclude = this._messages.slice(0, -1).slice(-6); // Last 6 messages, excluding current
        historyToInclude.forEach(msg => {
          contextParts.push(`[${msg.role === 'user' ? 'You' : 'Meta Engineer'}]: ${msg.content}`);
        });
        contextParts.push('');
      }

      contextParts.push('=== CURRENT QUESTION ===');
      contextParts.push(query);

      const payload = contextParts.join('\n');
      const rawOutput = await invokeClaudeCli(payload, META_ENGINEER_SYSTEM_PROMPT);

      // Add assistant response to history
      this._messages.push({
        role: 'assistant',
        content: rawOutput.trim(),
        timestamp: Date.now(),
      });

      this._update();
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      // Remove the user message if we failed
      this._messages.pop();
      this._sendError(`Meta Engineer failed: ${errorMsg}`);
      this._update();
    } finally {
      this._panel.webview.postMessage({ command: 'loading', loading: false });
    }
  }

  private _sendError(message: string) {
    this._panel.webview.postMessage({
      command: 'error',
      message,
    });
  }

  public dispose() {
    MetaEngineerPanel.currentPanel = undefined;

    this._panel.dispose();

    while (this._disposables.length) {
      const x = this._disposables.pop();
      if (x) {
        x.dispose();
      }
    }
  }

  private _update() {
    this._panel.webview.html = this._getHtmlForWebview();
  }

  private _getHtmlForWebview() {
    const nonce = getNonce();
    const messagesJson = JSON.stringify(this._messages);

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <title>Prompt Shaper</title>
  <style>
    :root {
      --bg-primary: var(--vscode-editor-background);
      --bg-secondary: var(--vscode-sideBar-background);
      --text-primary: var(--vscode-editor-foreground);
      --text-secondary: var(--vscode-descriptionForeground);
      --border-color: var(--vscode-panel-border);
      --accent-color: var(--vscode-button-background);
      --accent-hover: var(--vscode-button-hoverBackground);
      --input-bg: var(--vscode-input-background);
      --input-border: var(--vscode-input-border);
    }

    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }

    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--text-primary);
      background: var(--bg-primary);
      height: 100vh;
      display: flex;
      flex-direction: column;
    }

    .tabs {
      display: flex;
      border-bottom: 1px solid var(--border-color);
      background: var(--bg-secondary);
    }

    .tab {
      padding: 12px 24px;
      cursor: pointer;
      border: none;
      background: transparent;
      color: var(--text-secondary);
      font-size: 14px;
      font-weight: 500;
      transition: all 0.2s;
      border-bottom: 2px solid transparent;
    }

    .tab:hover {
      color: var(--text-primary);
      background: rgba(255,255,255,0.05);
    }

    .tab.active {
      color: var(--text-primary);
      border-bottom-color: var(--accent-color);
    }

    .tab-content {
      flex: 1;
      display: none;
      flex-direction: column;
      overflow: hidden;
    }

    .tab-content.active {
      display: flex;
    }

    .panel {
      flex: 1;
      padding: 20px;
      overflow-y: auto;
      display: flex;
      flex-direction: column;
      gap: 16px;
    }

    .input-area {
      padding: 16px;
      border-top: 1px solid var(--border-color);
      background: var(--bg-secondary);
    }

    .input-wrapper {
      display: flex;
      gap: 12px;
    }

    textarea {
      flex: 1;
      padding: 12px;
      border: 1px solid var(--input-border);
      border-radius: 6px;
      background: var(--input-bg);
      color: var(--text-primary);
      font-family: inherit;
      font-size: 14px;
      resize: none;
      min-height: 60px;
    }

    textarea:focus {
      outline: none;
      border-color: var(--accent-color);
    }

    button {
      padding: 12px 24px;
      border: none;
      border-radius: 6px;
      background: var(--accent-color);
      color: var(--vscode-button-foreground);
      cursor: pointer;
      font-size: 14px;
      font-weight: 500;
      transition: background 0.2s;
    }

    button:hover {
      background: var(--accent-hover);
    }

    button:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    button.secondary {
      background: transparent;
      border: 1px solid var(--border-color);
      color: var(--text-secondary);
    }

    button.secondary:hover {
      background: rgba(255,255,255,0.05);
      color: var(--text-primary);
    }

    .result-card {
      background: var(--bg-secondary);
      border: 1px solid var(--border-color);
      border-radius: 8px;
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
      font-size: 16px;
    }

    .result-content {
      background: var(--input-bg);
      padding: 12px;
      border-radius: 6px;
      white-space: pre-wrap;
      font-family: var(--vscode-editor-font-family);
      font-size: 13px;
      line-height: 1.5;
      max-height: 300px;
      overflow-y: auto;
    }

    .meta-list {
      margin-top: 12px;
      padding-left: 20px;
    }

    .meta-list li {
      margin: 4px 0;
      color: var(--text-secondary);
    }

    .message {
      padding: 12px 16px;
      border-radius: 8px;
      max-width: 85%;
    }

    .message.user {
      background: var(--accent-color);
      color: var(--vscode-button-foreground);
      align-self: flex-end;
      margin-left: auto;
    }

    .message.assistant {
      background: var(--bg-secondary);
      border: 1px solid var(--border-color);
      align-self: flex-start;
    }

    .message-content {
      white-space: pre-wrap;
      line-height: 1.5;
    }

    .messages-container {
      display: flex;
      flex-direction: column;
      gap: 12px;
      flex: 1;
    }

    .empty-state {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 100%;
      color: var(--text-secondary);
      text-align: center;
      gap: 12px;
    }

    .empty-state-icon {
      font-size: 48px;
      opacity: 0.5;
    }

    .loading {
      display: flex;
      align-items: center;
      gap: 8px;
      color: var(--text-secondary);
      padding: 12px;
    }

    .spinner {
      width: 16px;
      height: 16px;
      border: 2px solid var(--border-color);
      border-top-color: var(--accent-color);
      border-radius: 50%;
      animation: spin 1s linear infinite;
    }

    @keyframes spin {
      to { transform: rotate(360deg); }
    }

    .header-actions {
      display: flex;
      gap: 8px;
    }

    .error {
      background: var(--vscode-inputValidation-errorBackground);
      border: 1px solid var(--vscode-inputValidation-errorBorder);
      color: var(--vscode-inputValidation-errorForeground);
      padding: 12px;
      border-radius: 6px;
    }

    .placeholder-text {
      color: var(--text-secondary);
      font-style: italic;
    }
  </style>
</head>
<body>
  <div class="tabs">
    <button class="tab ${this._currentTab === 'shaper' ? 'active' : ''}" data-tab="shaper">
      Prompt Shaper
    </button>
    <button class="tab ${this._currentTab === 'meta' ? 'active' : ''}" data-tab="meta">
      Meta Engineer
    </button>
  </div>

  <!-- Prompt Shaper Tab -->
  <div class="tab-content ${this._currentTab === 'shaper' ? 'active' : ''}" id="shaper-tab">
    <div class="panel" id="shaper-panel">
      <div class="empty-state" id="shaper-empty">
        <div class="empty-state-icon">&#128221;</div>
        <div>Paste your dictated text below to shape it into a structured prompt</div>
      </div>
      <div id="shaper-result" style="display: none;"></div>
      <div id="shaper-loading" class="loading" style="display: none;">
        <div class="spinner"></div>
        <span>Shaping prompt with Claude...</span>
      </div>
    </div>
    <div class="input-area">
      <div class="input-wrapper">
        <textarea
          id="shaper-input"
          placeholder="Paste your dictated text here... (e.g., 'I want to add a button that shows user settings')"
          rows="3"
        ></textarea>
        <button id="shape-btn">Shape</button>
      </div>
    </div>
  </div>

  <!-- Meta Engineer Tab -->
  <div class="tab-content ${this._currentTab === 'meta' ? 'active' : ''}" id="meta-tab">
    <div class="panel" id="meta-panel">
      <div class="messages-container" id="meta-messages">
        ${this._messages.length === 0 ? `
          <div class="empty-state">
            <div class="empty-state-icon">&#129302;</div>
            <div><strong>Meta Engineer</strong></div>
            <div>Ask questions about your current conversation without affecting the main chat.</div>
            <div class="placeholder-text">e.g., "Am I approaching this problem correctly?" or "What am I missing?"</div>
          </div>
        ` : this._messages.map(msg => `
          <div class="message ${msg.role}">
            <div class="message-content">${escapeHtml(msg.content)}</div>
          </div>
        `).join('')}
      </div>
      <div id="meta-loading" class="loading" style="display: none;">
        <div class="spinner"></div>
        <span>Meta Engineer is thinking...</span>
      </div>
    </div>
    <div class="input-area">
      <div class="input-wrapper">
        <textarea
          id="meta-input"
          placeholder="Ask Meta Engineer about your current conversation..."
          rows="2"
        ></textarea>
        <button id="meta-btn">Ask</button>
        <button id="clear-meta-btn" class="secondary" title="Clear conversation">Clear</button>
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

    // Prompt Shaper
    const shaperInput = document.getElementById('shaper-input');
    const shapeBtn = document.getElementById('shape-btn');
    const shaperEmpty = document.getElementById('shaper-empty');
    const shaperResult = document.getElementById('shaper-result');
    const shaperLoading = document.getElementById('shaper-loading');

    shapeBtn.addEventListener('click', () => {
      const text = shaperInput.value.trim();
      if (text) {
        vscode.postMessage({ command: 'shapePrompt', text });
      }
    });

    shaperInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        shapeBtn.click();
      }
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
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        metaBtn.click();
      }
    });

    clearMetaBtn.addEventListener('click', () => {
      vscode.postMessage({ command: 'clearMetaHistory' });
    });

    // Handle messages from extension
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
                <button onclick="copyResult()">Copy to Clipboard</button>
              </div>
              <div class="result-content" id="shaped-prompt">\${escapeHtml(message.result.send_to_claude)}</div>
              \${message.result.assumptions.length > 0 ? \`
                <div style="margin-top: 16px;">
                  <strong>Assumptions:</strong>
                  <ul class="meta-list">
                    \${message.result.assumptions.map(a => \`<li>\${escapeHtml(a)}</li>\`).join('')}
                  </ul>
                </div>
              \` : ''}
              \${message.result.questions.length > 0 ? \`
                <div style="margin-top: 16px;">
                  <strong>Questions (needs clarification):</strong>
                  <ul class="meta-list">
                    \${message.result.questions.map(q => \`<li>\${escapeHtml(q)}</li>\`).join('')}
                  </ul>
                </div>
              \` : ''}
            </div>
          \`;
          shaperInput.value = '';
          break;

        case 'error':
          const errorHtml = \`<div class="error">\${escapeHtml(message.message)}</div>\`;
          if (document.getElementById('shaper-tab').classList.contains('active')) {
            shaperEmpty.style.display = 'none';
            shaperResult.style.display = 'block';
            shaperResult.innerHTML = errorHtml;
          }
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

    // Scroll to bottom of meta messages
    if (metaMessages) {
      metaMessages.scrollTop = metaMessages.scrollHeight;
    }
  </script>
</body>
</html>`;
  }
}

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

// ============================================================================
// Extension Lifecycle
// ============================================================================

export function activate(context: vscode.ExtensionContext): void {
  // Original command
  const dictateCommand = vscode.commands.registerCommand(
    'promptShaper.dictateAndShape',
    dictateAndShape
  );

  // New panel command
  const openPanelCommand = vscode.commands.registerCommand(
    'promptShaper.openPanel',
    () => {
      MetaEngineerPanel.createOrShow(context.extensionUri);
    }
  );

  context.subscriptions.push(dictateCommand);
  context.subscriptions.push(openPanelCommand);

  console.log('Prompt Shaper extension activated');
}

export function deactivate(): void {
  cachedCliConfig = null;
}

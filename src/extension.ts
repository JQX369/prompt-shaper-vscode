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
  // Claude Code encodes paths by replacing '/' with '-' (and possibly other chars)
  // Try multiple encodings to find a match
  return workspacePath.replace(/\//g, '-').replace(/^-/, '');
}

async function findAllJsonlFiles(dir: string): Promise<{ path: string; mtime: Date }[]> {
  const results: { path: string; mtime: Date }[] = [];

  async function walk(currentDir: string): Promise<void> {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(currentDir, { withFileTypes: true });
    } catch {
      return; // Skip directories we can't read
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

  // Check if projects path exists
  if (!fs.existsSync(projectsPath)) {
    return null;
  }

  const allJsonlFiles = await findAllJsonlFiles(projectsPath);

  if (allJsonlFiles.length === 0) {
    return null;
  }

  // Try to find files that match the workspace path
  const encodedPath = encodeWorkspacePath(workspaceRoot);
  const workspaceBasename = path.basename(workspaceRoot);

  // Score each file based on how well it matches the workspace
  const scored = allJsonlFiles.map(file => {
    let score = 0;
    const filePath = file.path.toLowerCase();
    const encodedLower = encodedPath.toLowerCase();
    const basenameLower = workspaceBasename.toLowerCase();

    // Strong match: contains encoded full path
    if (filePath.includes(encodedLower)) {
      score += 100;
    }

    // Medium match: contains workspace folder name
    if (filePath.includes(basenameLower)) {
      score += 50;
    }

    // Add recency bonus (more recent = higher score)
    const ageMs = Date.now() - file.mtime.getTime();
    const ageHours = ageMs / (1000 * 60 * 60);
    score += Math.max(0, 24 - ageHours); // Bonus up to 24 for files modified in last 24h

    return { ...file, score };
  });

  // Sort by score descending, then by mtime descending
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
    // File is small enough, read it all
    return fs.promises.readFile(filePath, 'utf-8');
  }

  // Read only the tail
  const fd = await fs.promises.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(maxBytes);
    const startPos = fileSize - maxBytes;
    await fd.read(buffer, 0, maxBytes, startPos);
    const content = buffer.toString('utf-8');

    // Find the first complete line (skip partial first line)
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

      // Claude Code JSONL format varies; try multiple structures
      // Common structure: { type: "...", message: { role, content } }
      // Or: { role: "...", content: "..." }
      // Or: { type: "user" | "assistant", ... }

      let role: 'user' | 'assistant' | null = null;
      let content: string | null = null;

      // Try direct role/content
      if (obj.role === 'user' || obj.role === 'assistant') {
        role = obj.role;
        content = extractContent(obj.content);
      }
      // Try type field as role indicator
      else if (obj.type === 'user' || obj.type === 'human') {
        role = 'user';
        content = extractContent(obj.message || obj.content || obj.text);
      }
      else if (obj.type === 'assistant' || obj.type === 'ai') {
        role = 'assistant';
        content = extractContent(obj.message || obj.content || obj.text);
      }
      // Try nested message structure
      else if (obj.message?.role) {
        role = obj.message.role === 'user' || obj.message.role === 'human' ? 'user' :
               obj.message.role === 'assistant' || obj.message.role === 'ai' ? 'assistant' : null;
        content = extractContent(obj.message.content);
      }

      if (role && content && content.trim()) {
        messages.push({ role, content: content.trim() });
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
    // Handle array of content blocks
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

  // Walk backwards to get most recent messages
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
    // Try to get help output
    let helpOutput = '';
    try {
      helpOutput = execSync('claude --help 2>&1', {
        encoding: 'utf-8',
        timeout: 10000,
      });
    } catch (e: unknown) {
      // --help might exit with non-zero, that's ok
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

    // Detect print/prompt flag for non-interactive mode
    // Common patterns: -p, --print, --prompt, --non-interactive
    if (helpLower.includes('-p') && (helpLower.includes('print') || helpLower.includes('prompt') || helpLower.includes('non-interactive'))) {
      config.printFlag = '-p';
    } else if (helpLower.includes('--print')) {
      config.printFlag = '--print';
    } else if (helpLower.includes('--prompt')) {
      config.printFlag = '--prompt';
    } else if (helpLower.includes('--non-interactive')) {
      config.printFlag = '--non-interactive';
    } else {
      // Default to -p as it's commonly used
      config.printFlag = '-p';
    }

    // Detect system prompt flag
    if (helpLower.includes('--system-prompt')) {
      config.systemPromptFlag = '--system-prompt';
    } else if (helpLower.includes('--system')) {
      config.systemPromptFlag = '--system';
    } else if (helpLower.includes('-s') && helpLower.includes('system')) {
      config.systemPromptFlag = '-s';
    }

    // Check for environment variable support
    if (helpLower.includes('claude_system_prompt') || helpLower.includes('system_prompt')) {
      config.systemPromptEnv = 'CLAUDE_SYSTEM_PROMPT';
    }

  } catch {
    // CLI detection failed, use defaults
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

    // Build argument list based on detected config
    // Always use -p for non-interactive/print mode
    if (cliConfig.printFlag) {
      args.push(cliConfig.printFlag);
    }

    // Add output format for cleaner output
    args.push('--output-format', 'text');

    // Skip permissions to avoid interactive dialogs - this is safe since
    // we're only using Claude for text transformation, not file operations
    args.push('--dangerously-skip-permissions');

    // Don't persist or load session - we want a fresh context each time
    args.push('--no-session-persistence');

    // Try system prompt flag first
    if (cliConfig.systemPromptFlag) {
      args.push(cliConfig.systemPromptFlag, systemPrompt);
      args.push(payload);
    }
    // Fall back to environment variable
    else if (cliConfig.systemPromptEnv) {
      env[cliConfig.systemPromptEnv] = systemPrompt;
      args.push(payload);
    }
    // Last resort: prepend system prompt to payload
    else {
      const combinedPayload = `[SYSTEM INSTRUCTIONS]\n${systemPrompt}\n\n[USER REQUEST]\n${payload}`;
      args.push(combinedPayload);
    }

    // Use execSync-style spawn with proper stdio handling
    const proc = spawn('claude', args, {
      env,
      stdio: ['ignore', 'pipe', 'pipe'], // ignore stdin to prevent hanging
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
        return; // Already rejected
      }
      if (code === 0 || stdout.trim()) {
        resolve(stdout);
      } else {
        reject(new Error(`Claude CLI exited with code ${code}: ${stderr || 'No output'}`));
      }
    });

    // Set timeout (2 minutes for slower responses)
    const timeout = setTimeout(() => {
      timedOut = true;
      proc.kill('SIGTERM');
      // Give it a moment to clean up, then force kill
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
  // Try to find JSON object in the output
  // Look for first { and matching }
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

  // Validate required fields
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
// Main Command Implementation
// ============================================================================

async function dictateAndShape(): Promise<void> {
  // 1. Check workspace
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) {
    vscode.window.showErrorMessage(
      'Prompt Shaper: No workspace folder open. Please open a folder first.'
    );
    return;
  }

  const workspaceRoot = workspaceFolders[0].uri.fsPath;

  // 2. Check platform / Claude projects path
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

  // 3. Check Claude CLI
  if (!isClaudeCliInstalled()) {
    vscode.window.showErrorMessage(
      'Prompt Shaper: Claude CLI not found on PATH. ' +
      'Please install Claude Code CLI: https://docs.anthropic.com/en/docs/claude-code'
    );
    return;
  }

  // 4. Get dictation input
  const dictation = await vscode.window.showInputBox({
    title: 'Prompt Shaper',
    prompt: 'Paste your dictated text here (use OS dictation, then paste)',
    placeHolder: 'I want to add a feature that does...',
    ignoreFocusOut: true,
  });

  if (!dictation || !dictation.trim()) {
    return; // User cancelled
  }

  // 5. Show progress
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'Prompt Shaper',
      cancellable: false,
    },
    async (progress) => {
      progress.report({ message: 'Finding session context...' });

      const config = getConfig();

      // 6. Find and read session file
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
          // Continue without context
        }
      }

      // 7. Build payload
      progress.report({ message: 'Shaping prompt with Claude...' });

      const payload = buildPayload(workspaceRoot, assistantMessages, userMessages, dictation);

      // 8. Call Claude CLI
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

      // 9. Parse output
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

        // Log to output channel
        const channel = vscode.window.createOutputChannel('Prompt Shaper');
        channel.appendLine('=== Raw Claude Output ===');
        channel.appendLine(rawOutput);
        channel.show();
        return;
      }

      // 10. Copy to clipboard
      await vscode.env.clipboard.writeText(shaped.send_to_claude);

      // 11. Show success notification
      let notification = `Shaped prompt copied to clipboard!`;
      if (shaped.questions.length > 0) {
        notification += ` (${shaped.questions.length} clarifying question${shaped.questions.length > 1 ? 's' : ''} included)`;
      }

      vscode.window.showInformationMessage(notification);

      // 12. Optionally show details
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
      // Truncate very long messages for context
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
// Extension Lifecycle
// ============================================================================

export function activate(context: vscode.ExtensionContext): void {
  const disposable = vscode.commands.registerCommand(
    'promptShaper.dictateAndShape',
    dictateAndShape
  );

  context.subscriptions.push(disposable);

  console.log('Prompt Shaper extension activated');
}

export function deactivate(): void {
  cachedCliConfig = null;
}

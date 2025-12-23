# Prompt Shaper VS Code Extension

Turn messy dictated text into structured, send-ready prompts for Claude Code.

## Features

- **One Command**: Run "Prompt Shaper: Dictate → Shape → Copy" from the Command Palette
- **Context-Aware**: Automatically reads recent Claude Code session history from your workspace
- **Smart Shaping**: Uses Claude to transform raw dictation into actionable prompts
- **Clipboard Ready**: Final prompt is copied directly to your clipboard

## Requirements

1. **Claude Code CLI** must be installed and available on your PATH
   - Install from: https://docs.anthropic.com/en/docs/claude-code
   - Make sure you've logged in by running `claude` in your terminal at least once

2. **macOS** (primary support)
   - The extension reads Claude Code session logs from `~/.claude/projects/`
   - Windows/Linux: Will show a friendly error if the log path is not found

## Installation (Local Development)

### Option 1: Run via F5 (Recommended for development)

```bash
# 1. Navigate to the extension folder
cd prompt-shaper-vscode

# 2. Install dependencies
npm install

# 3. Compile TypeScript
npm run compile

# 4. Open the folder in VS Code
code .

# 5. Press F5 to launch Extension Development Host
#    A new VS Code window will open with the extension loaded
```

### Option 2: Install as VSIX

```bash
# 1. Install vsce if you don't have it
npm install -g @vscode/vsce

# 2. Package the extension
cd prompt-shaper-vscode
npm install
npm run compile
vsce package --allow-missing-repository

# 3. Install the .vsix file
code --install-extension prompt-shaper-*.vsix
```

## Usage

1. **Open a workspace** in VS Code (the extension needs a workspace to find context)

2. **Dictate your thoughts** using your OS dictation feature:
   - macOS: Press `Fn Fn` (double-tap Function key) or enable in System Settings > Keyboard > Dictation
   - Copy the dictated text to clipboard

3. **Run the command**:
   - Open Command Palette: `Cmd+Shift+P` (macOS) or `Ctrl+Shift+P` (Windows/Linux)
   - Type: `Prompt Shaper: Dictate → Shape → Copy`
   - Press Enter

4. **Paste your dictation** into the input box that appears

5. **Wait** a few seconds for Claude to shape your prompt

6. **Paste** (`Cmd+V` / `Ctrl+V`) the shaped prompt into your Claude Code chat

## Settings

Configure in VS Code Settings (search "Prompt Shaper"):

| Setting | Default | Description |
|---------|---------|-------------|
| `promptShaper.maxAssistantMessages` | 3 | Number of recent assistant messages to include in context |
| `promptShaper.maxUserMessages` | 2 | Number of recent user messages to include in context |
| `promptShaper.maxTailBytes` | 250000 | Maximum bytes to read from session log (tail-read for efficiency) |

## How It Works

1. **Context Discovery**: Finds the most relevant Claude Code session file for your workspace
   - Searches `~/.claude/projects/` for JSONL files
   - Prefers files matching your workspace path
   - Falls back to most recently modified session

2. **Efficient Reading**: Tail-reads only the last N bytes (default 250KB) to avoid memory issues with large logs

3. **Message Extraction**: Parses JSONL to extract recent assistant and user messages

4. **Claude Shaping**: Sends your dictation + context to Claude CLI with a carefully designed system prompt

5. **JSON Output**: Claude returns structured JSON with:
   - `title`: Brief title for the prompt
   - `send_to_claude`: The actual prompt to send (this gets copied to clipboard)
   - `assumptions`: What the shaper assumed about your intent
   - `questions`: Clarifying questions if your dictation was ambiguous

## Troubleshooting

### "Claude CLI not found"
- Install Claude Code: https://docs.anthropic.com/en/docs/claude-code
- Make sure `claude` is in your PATH
- Try running `claude` in your terminal to verify

### "No workspace folder open"
- Open a folder in VS Code before running the command
- File > Open Folder

### "Claude Code projects directory not found"
- Run Claude Code at least once in any project to create the logs directory
- On non-macOS: Claude Code may store logs in a different location

### "Claude CLI timed out"
- The extension uses `--dangerously-skip-permissions` to avoid interactive dialogs
- Make sure you're logged in: run `claude` in terminal first
- Test manually: `claude -p --dangerously-skip-permissions "test"`

### "Failed to parse Claude output"
- Check the "Prompt Shaper" Output panel for the raw response
- The Claude CLI may have returned an error or unexpected format
- Try running `claude -p --dangerously-skip-permissions "test"` in terminal to verify CLI works

### Extension not appearing in Command Palette
- Make sure you compiled: `npm run compile`
- Restart VS Code or the Extension Development Host
- Check Output panel for activation errors

## Development

```bash
# Watch mode for development
npm run watch

# In VS Code, press F5 to launch Extension Development Host
# Changes will auto-compile, just reload the window (Cmd+R)
```

## Output Schema

The shaper produces JSON with this structure:

```json
{
  "title": "Add user authentication",
  "send_to_claude": "## Task\nImplement user authentication with the following requirements:\n- OAuth2 support\n- Session management\n- ...",
  "assumptions": [
    "Using the existing Express.js backend",
    "PostgreSQL for session storage"
  ],
  "questions": [
    "Should this support social login (Google, GitHub)?",
    "What session timeout duration is preferred?"
  ],
  "verbatim": "okay so I want to add user authentication..."
}
```

Only `send_to_claude` is copied to clipboard. Check the Output panel to see assumptions and questions.

## License

MIT

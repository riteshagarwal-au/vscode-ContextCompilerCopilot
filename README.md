# vscode-ContextCompilerCopilot

VS Code extension that automatically optimises every GitHub Copilot prompt — strips VS Code injected boilerplate, trims old tool-call history, and filters irrelevant system-prompt sections — all transparently, with zero user friction.

**No Python. No Docker. No separate server. Just install and go.**

---

## How it works

On activation the extension:
1. Starts a lightweight HTTP proxy on `localhost:8181` (inside the extension process)
2. Automatically sets `github.copilot.advanced.debug.overrideProxyUrl` so VS Code Copilot routes through it
3. Every Copilot request passes through the CC2 pipeline before reaching GitHub's API
4. On deactivation the proxy stops and the Copilot setting is restored

```
VS Code Copilot  →  localhost:8181 (this extension)  →  api.githubcopilot.com
                          │
                    Pipeline:
                    1. Boilerplate strip   (always, free)
                    2. Mode detection
                    3. Section extraction  (agent mode only, uses vscode.lm)
                    4. History trimming    (agent mode only)
```

**Authentication:** Uses VS Code's existing GitHub session — the user is already signed in for Copilot. No extra login required.

---

## Prerequisites

- VS Code 1.95+
- GitHub Copilot subscription (already signed in)

That's it.

---

## Install

```
ext install contextcompiler.vscode-context-compiler-copilot
```

Or install from `.vsix`:
```bash
code --install-extension vscode-context-compiler-copilot-0.1.0.vsix
```

---

## Commands

| Command | Description |
|---|---|
| `Context Compiler: Toggle On/Off` | Enable or disable the proxy |
| `Context Compiler: Show Token Savings` | Quick summary in notification |
| `Context Compiler: Open Dashboard` | Full WebView with per-mode stats |

---

## Settings

| Setting | Default | Description |
|---|---|---|
| `contextCompilerCopilot.enabled` | `true` | Enable/disable the proxy |
| `contextCompilerCopilot.proxyPort` | `8181` | Local port for the embedded proxy |
| `contextCompilerCopilot.recentTurns` | `3` | History trimmer window |
| `contextCompilerCopilot.maxToolChars` | `200` | Max chars from old tool results |
| `contextCompilerCopilot.extractionModel` | `claude-haiku-4.5` | Model family for section extraction |
| `contextCompilerCopilot.logExchanges` | `false` | Write JSONL exchange log (off for privacy) |

---

## Development

```bash
cd vscode-ContextCompilerCopilot

# Install dependencies (also links the local ContextCompiler-TypeScript library)
npm install

# Build
npm run build

# Watch mode
npm run dev

# Package .vsix
npm run package
```

Open in VS Code and press **F5** to launch the Extension Development Host.

---

## Architecture

```
src/
  extension.ts      — Activation, deactivation, commands, config watcher
  proxy-server.ts   — Embedded HTTP server; orchestrates pipeline per request
  llm-caller.ts     — Adapts vscode.lm API into the CallLLM interface
  dashboard.ts      — WebView panel with token-savings stats
```

The pipeline logic lives in `../ContextCompiler-TypeScript` (shared library).

/**
 * extension.ts — VS Code extension entry point.
 *
 * On activation:
 *  1. Starts an embedded HTTP proxy on a configurable port (default 8181)
 *  2. Sets github.copilot.advanced.debug.overrideProxyUrl to point to it
 *  3. Registers commands: Show Stats, Toggle, Open Dashboard
 *  4. On deactivation: stops the proxy and restores the Copilot setting
 */

import * as vscode from 'vscode';
import { ProxyServer } from './proxy-server';
import { showDashboard } from './dashboard';
import { computeStats, config as ccConfig } from 'context-compiler-typescript';
import * as os from 'os';
import * as path from 'path';
// Set exchange path before any library calls
ccConfig.exchangesPath = path.join(os.homedir(), 'Library', 'Application Support', 'Code', 'User', 'ccc_exchanges.jsonl');
import { registerChatParticipant } from './chat-participant';
import { StatusViewProvider, StatsViewProvider } from './sidebar';
import { syncChatLanguageModels } from './chat-language-models';

const COPILOT_PROXY_SETTING = 'github.copilot.advanced';
const PROXY_URL_KEY = 'debug.overrideProxyUrl';

let proxyServer: ProxyServer | null = null;
let outputChannel: vscode.OutputChannel;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  try {
    outputChannel = vscode.window.createOutputChannel('Context Compiler');
    context.subscriptions.push(outputChannel);
  } catch {
    // Extension host lifecycle edge case — create channel without registering for disposal
    outputChannel = vscode.window.createOutputChannel('Context Compiler');
  }

  outputChannel.appendLine('[cc] Activating Context Compiler Copilot extension...');

  const cfg = vscode.workspace.getConfiguration('contextCompilerCopilot');
  const enabled = cfg.get<boolean>('enabled', true);
  const port = cfg.get<number>('proxyPort', 8181);

  // Sidebar views — register FIRST so they always show even if proxy fails
  const statusViewProvider = new StatusViewProvider();
  const statsViewProvider = new StatsViewProvider();
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('contextCompilerCopilot.statusView', statusViewProvider),
    vscode.window.registerTreeDataProvider('contextCompilerCopilot.statsView', statsViewProvider),
  );

  if (enabled) {
    try {
      await startProxy(context, port);
    } catch (err) {
      outputChannel.appendLine(`[cc] startProxy failed: ${err}`);
      vscode.window.showErrorMessage(`Context Compiler: proxy failed to start — ${err}`);
    }
  }

  // Commands
  context.subscriptions.push(
    vscode.commands.registerCommand('contextCompilerCopilot.showStats', () => {
      const stats = computeStats();
      vscode.window.showInformationMessage(
        `Context Compiler: ${stats.totalRequests} requests | ${stats.totalTokensSaved.toLocaleString()} tokens saved (${stats.avgSavingsPct}% avg)`,
      );
    }),

    vscode.commands.registerCommand('contextCompilerCopilot.toggleEnabled', async () => {
      const current = vscode.workspace
        .getConfiguration('contextCompilerCopilot')
        .get<boolean>('enabled', true);

      await vscode.workspace
        .getConfiguration('contextCompilerCopilot')
        .update('enabled', !current, vscode.ConfigurationTarget.Global);

      if (!current) {
        const p = vscode.workspace.getConfiguration('contextCompilerCopilot').get<number>('proxyPort', 8181);
        await startProxy(context, p);
        vscode.window.showInformationMessage('Context Compiler: enabled ✓');
      } else {
        await stopProxy();
        vscode.window.showInformationMessage('Context Compiler: disabled');
      }
    }),

    vscode.commands.registerCommand('contextCompilerCopilot.showDashboard', () => {
      showDashboard(context);
    }),

    vscode.commands.registerCommand('contextCompilerCopilot.restartProxy', async () => {
      const p = vscode.workspace.getConfiguration('contextCompilerCopilot').get<number>('proxyPort', 8181);
      await stopProxy();
      await startProxy(context, p);
      const model = vscode.workspace.getConfiguration('contextCompilerCopilot').get<string>('extractionModel', 'claude-haiku-4.5');
      statusViewProvider.update(!!proxyServer?.isRunning, p, model);
      vscode.window.showInformationMessage(`Context Compiler: proxy restarted on port ${p}`);
    }),

    vscode.commands.registerCommand('contextCompilerCopilot.changePort', async () => {
      const current = vscode.workspace.getConfiguration('contextCompilerCopilot').get<number>('proxyPort', 8181);
      const input = await vscode.window.showInputBox({
        prompt: 'Enter new proxy port number',
        value: String(current),
        validateInput: v => /^\d+$/.test(v) && +v > 1024 && +v < 65536 ? null : 'Enter a port between 1025 and 65535',
      });
      if (!input) return;
      await vscode.workspace.getConfiguration('contextCompilerCopilot').update('proxyPort', Number(input), vscode.ConfigurationTarget.Global);
    }),

    vscode.commands.registerCommand('contextCompilerCopilot.changeExtractionModel', async () => {
      const models = [
        { label: 'claude-haiku-4.5', description: 'Claude Haiku 4.5 (fastest, cheapest)' },
        { label: 'gemini-3-flash-preview', description: 'Gemini 3 Flash' },
        { label: 'gpt-5-mini', description: 'GPT-5 Mini' },
        { label: 'gpt-4o-mini', description: 'GPT-4o Mini (Free)' },
        { label: 'gpt-4o', description: 'GPT-4o (Free)' },
        { label: 'gpt-4.1', description: 'GPT-4.1 (Free)' },
        { label: 'gpt-4', description: 'GPT-4 (Free)' },
        { label: 'gpt-3.5-turbo', description: 'GPT-3.5 Turbo (Free)' },
      ];
      const current = vscode.workspace.getConfiguration('contextCompilerCopilot').get<string>('extractionModel', 'claude-haiku-4.5');
      const picked = await vscode.window.showQuickPick(models, {
        title: 'Select Extraction Model',
        placeHolder: `Current: ${current}`,
      });
      if (!picked) return;
      await vscode.workspace.getConfiguration('contextCompilerCopilot').update('extractionModel', picked.label, vscode.ConfigurationTarget.Global);
      const p = vscode.workspace.getConfiguration('contextCompilerCopilot').get<number>('proxyPort', 8181);
      statusViewProvider.update(!!proxyServer?.isRunning, p, picked.label);
      vscode.window.showInformationMessage(`Extraction model set to ${picked.label}`);
    }),
  );

  // React to configuration changes
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(async (e) => {
      if (!e.affectsConfiguration('contextCompilerCopilot')) return;

      const newCfg = vscode.workspace.getConfiguration('contextCompilerCopilot');
      const nowEnabled = newCfg.get<boolean>('enabled', true);
      const nowPort = newCfg.get<number>('proxyPort', 8181);
      const nowModel = newCfg.get<string>('extractionModel', 'claude-haiku-4.5');

      if (nowEnabled && !proxyServer?.isRunning) {
        await startProxy(context, nowPort);
      } else if (!nowEnabled && proxyServer?.isRunning) {
        await stopProxy();
      } else if (nowEnabled && proxyServer?.isRunning && nowPort !== proxyServer.port) {
        // Port changed — restart on new port
        await stopProxy();
        await startProxy(context, nowPort);
      }
      statusViewProvider.update(!!proxyServer?.isRunning, nowPort, nowModel);
    }),
  );

  outputChannel.appendLine('[cc] Extension activated.');

  statusViewProvider.update(enabled && !!proxyServer?.isRunning, port, cfg.get<string>('extractionModel', 'claude-haiku-4.5'));

  // Refresh sidebar every 10 s while extension is alive
  const refreshTimer = setInterval(() => statsViewProvider.refresh(), 10_000);
  context.subscriptions.push({ dispose: () => clearInterval(refreshTimer) });

  // Register CCC tab in Copilot Chat
  registerChatParticipant(context, outputChannel);
}

export async function deactivate(): Promise<void> {
  await stopProxy();
  outputChannel?.appendLine('[cc] Extension deactivated.');
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function startProxy(context: vscode.ExtensionContext, port: number): Promise<void> {
  proxyServer = new ProxyServer(outputChannel, context.storageUri);
  proxyServer.start(port);

  // Tell Copilot to route through our proxy
  await setCopilotProxyUrl(`http://127.0.0.1:${port}`);

  vscode.window.showInformationMessage(
    `Context Compiler active on port ${port} — Copilot prompts are being optimised.`,
  );

  // Update chatLanguageModels.json with all available Copilot models
  syncChatLanguageModels(outputChannel);
}

async function stopProxy(): Promise<void> {
  proxyServer?.stop();
  proxyServer = null;
  await clearCopilotProxyUrl();
}

async function setCopilotProxyUrl(url: string): Promise<void> {
  try {
    const copilotConfig = vscode.workspace.getConfiguration(COPILOT_PROXY_SETTING);
    const current = copilotConfig.get<Record<string, unknown>>('') ?? {};
    await copilotConfig.update(
      PROXY_URL_KEY,
      url,
      vscode.ConfigurationTarget.Global,
    );
    outputChannel.appendLine(`[cc] Set ${COPILOT_PROXY_SETTING}.${PROXY_URL_KEY} = ${url}`);
  } catch (err) {
    outputChannel.appendLine(`[cc] Warning: could not set Copilot proxy URL: ${err}`);
  }
}

async function clearCopilotProxyUrl(): Promise<void> {
  try {
    const copilotConfig = vscode.workspace.getConfiguration(COPILOT_PROXY_SETTING);
    await copilotConfig.update(PROXY_URL_KEY, undefined, vscode.ConfigurationTarget.Global);
    outputChannel.appendLine(`[cc] Cleared ${COPILOT_PROXY_SETTING}.${PROXY_URL_KEY}`);
  } catch (err) {
    outputChannel.appendLine(`[cc] Warning: could not clear Copilot proxy URL: ${err}`);
  }
}

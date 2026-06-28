/**
 * chat-language-models.ts
 *
 * Fetches the list of available models from the Copilot API and upserts the
 * "ContextCompilerCopilot" entry in ~/Library/Application Support/Code/User/chatLanguageModels.json
 * so the user always has all current models available via the CCC extension proxy.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { getCopilotToken } from './copilot-auth';

const ENTRY_NAME = 'ContextCompilerCopilot';

const FREE_MODEL_IDS = new Set(['gpt-3.5-turbo', 'gpt-4', 'gpt-4.1', 'gpt-4o', 'gpt-4o-mini']);

function modelDisplayName(id: string, displayName: string): string {
  if (FREE_MODEL_IDS.has(id)) {
    return `${displayName} (Free)`;
  }
  return displayName;
}

interface ModelEntry {
  id: string;
  name: string;
  url: string;
  toolCalling: boolean;
  vision: boolean;
  maxInputTokens: number;
  maxOutputTokens: number;
  reasoningEffort?: string;
}

interface LMEntry {
  name: string;
  vendor: string;
  apiKey: string;
  apiType: string;
  models: ModelEntry[];
}

/** Return the path to chatLanguageModels.json for the current platform. */
function getChatLMPath(): string {
  const platform = process.platform;
  if (platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Code', 'User', 'chatLanguageModels.json');
  } else if (platform === 'win32') {
    return path.join(process.env.APPDATA ?? os.homedir(), 'Code', 'User', 'chatLanguageModels.json');
  } else {
    return path.join(os.homedir(), '.config', 'Code', 'User', 'chatLanguageModels.json');
  }
}

/** Fetch models from the Copilot API.  Returns [] on any error. */
async function fetchCopilotModels(outputChannel: vscode.OutputChannel): Promise<ModelEntry[]> {
  try {
    const { token, baseUrl } = await getCopilotToken();
    const modelsUrl = baseUrl.includes('enterprise') || baseUrl.includes('business')
      ? `${baseUrl}/models`
      : `${baseUrl}/v1/models`;

    const resp = await fetch(modelsUrl, {
      headers: {
        Authorization: `Bearer ${token}`,
        'Editor-Version': 'vscode/1.95.0',
        'Editor-Plugin-Version': 'copilot/1.0.0',
        'User-Agent': 'GithubCopilot/1.0.0',
        'Copilot-Integration-Id': 'vscode-chat',
      },
    });

    if (!resp.ok) {
      outputChannel.appendLine(`[cc:lm] Models API returned ${resp.status} — using fallback list`);
      return buildFallbackModels();
    }

    const json = await resp.json() as { data?: Array<{ id: string; capabilities?: { limits?: { max_prompt_tokens?: number; max_output_tokens?: number }; supports?: { tool_calls?: boolean; vision?: boolean } }; name?: string; model_picker_enabled?: boolean }> };
    const data = json.data ?? [];

    const port = vscode.workspace.getConfiguration('contextCompilerCopilot').get<number>('proxyPort', 8181);
    const proxyUrl = `http://localhost:${port}/v1`;

    // Filter: only picker-enabled chat models, skip embeddings
    const apiModels = data
      .filter(m => m.model_picker_enabled !== false && !m.id.includes('embedding'))
      .map(m => {
        const limits = m.capabilities?.limits ?? {};
        const supports = m.capabilities?.supports ?? {};
        const isReasoning = m.id.includes('o1') || m.id.includes('o3') || m.id.includes('thinking');
        const entry: ModelEntry = {
          id: m.id,
          name: modelDisplayName(m.id, m.name ?? m.id),
          url: proxyUrl,
          toolCalling: supports.tool_calls ?? true,
          vision: supports.vision ?? false,
          maxInputTokens: limits.max_prompt_tokens ?? 128000,
          maxOutputTokens: limits.max_output_tokens ?? 8096,
        };
        if (isReasoning) {
          entry.reasoningEffort = 'low';
        }
        return entry;
      });

    // Ensure free models are always present (enterprise API may not list them)
    const returnedIds = new Set(apiModels.map(m => m.id));
    const missingFree = buildFreeModels(proxyUrl).filter(m => !returnedIds.has(m.id));
    return [...apiModels, ...missingFree];
  } catch (err) {
    outputChannel.appendLine(`[cc:lm] Could not fetch models: ${err}`);
    return buildFallbackModels();
  }
}

/** Free-tier models always included regardless of what the API returns. */
function buildFreeModels(proxyUrl: string): ModelEntry[] {
  return [
    { id: 'gpt-3.5-turbo', name: 'GPT-3.5 Turbo (Free)', url: proxyUrl, toolCalling: true, vision: false, maxInputTokens: 16385, maxOutputTokens: 4096 },
    { id: 'gpt-4',         name: 'GPT-4 (Free)',         url: proxyUrl, toolCalling: true, vision: false, maxInputTokens: 8192,  maxOutputTokens: 4096 },
    { id: 'gpt-4.1',       name: 'GPT-4.1 (Free)',       url: proxyUrl, toolCalling: true, vision: true,  maxInputTokens: 128000, maxOutputTokens: 8096 },
    { id: 'gpt-4o',        name: 'GPT-4o (Free)',        url: proxyUrl, toolCalling: true, vision: true,  maxInputTokens: 128000, maxOutputTokens: 8096 },
    { id: 'gpt-4o-mini',   name: 'GPT-4o mini (Free)',   url: proxyUrl, toolCalling: true, vision: true,  maxInputTokens: 128000, maxOutputTokens: 8096 },
  ];
}

/** Minimal fallback if the API is unreachable. */
function buildFallbackModels(): ModelEntry[] {
  const port = vscode.workspace.getConfiguration('contextCompilerCopilot').get<number>('proxyPort', 8181);
  const proxyUrl = `http://localhost:${port}/v1`;
  return [
    ...buildFreeModels(proxyUrl),
    { id: 'claude-sonnet-4.6', name: 'Claude Sonnet 4.6', url: proxyUrl, toolCalling: true, vision: true, maxInputTokens: 128000, maxOutputTokens: 8096, reasoningEffort: 'low' },
    { id: 'claude-haiku-4.5',  name: 'Claude Haiku 4.5',  url: proxyUrl, toolCalling: true, vision: false, maxInputTokens: 128000, maxOutputTokens: 8096, reasoningEffort: 'low' },
  ];
}

/**
 * Upsert the ContextCompilerCopilot entry in chatLanguageModels.json.
 * Called once at extension activation.
 */
export async function syncChatLanguageModels(outputChannel: vscode.OutputChannel): Promise<void> {
  try {
    const filePath = getChatLMPath();
    outputChannel.appendLine(`[cc:lm] Syncing ${filePath}`);

    // Read existing file
    let entries: LMEntry[] = [];
    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, 'utf8');
      entries = JSON.parse(raw) as LMEntry[];
    }

    // Fetch models
    const models = await fetchCopilotModels(outputChannel);
    if (models.length === 0) {
      outputChannel.appendLine('[cc:lm] No models returned — skipping update');
      return;
    }

    const newEntry: LMEntry = {
      name: ENTRY_NAME,
      vendor: 'customendpoint',
      apiKey: 'dummy-key-for-local',
      apiType: 'chat-completions',
      models,
    };

    // Replace existing entry or append
    const idx = entries.findIndex(e => e.name === ENTRY_NAME);
    if (idx >= 0) {
      entries[idx] = newEntry;
    } else {
      entries.push(newEntry);
    }

    fs.writeFileSync(filePath, JSON.stringify(entries, null, '\t'), 'utf8');
    outputChannel.appendLine(`[cc:lm] Wrote ${models.length} models to chatLanguageModels.json`);
    vscode.window.showInformationMessage(
      `Context Compiler: updated chatLanguageModels.json with ${models.length} models.`,
    );
  } catch (err) {
    outputChannel.appendLine(`[cc:lm] Failed to sync chatLanguageModels.json: ${err}`);
  }
}

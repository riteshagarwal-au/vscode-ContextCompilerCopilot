/**
 * llm-caller.ts — Builds a CallLLM backed by vscode.lm (VS Code's native LLM API).
 *
 * This replaces Copilot Proxy entirely — VS Code already holds the user's
 * GitHub token. No OAuth flow, no sidecar process needed.
 *
 * The cheap model (haiku-equivalent) is selected from the models available in
 * vscode.lm. We prefer small/fast families; fall back to whatever is available.
 */

import * as vscode from 'vscode';
import type { CallLLM, LLMUsage } from 'context-compiler-typescript';
import { getCopilotToken } from './copilot-auth';

function normalisePath(path: string, baseUrl: string): string {
  if (baseUrl.includes('enterprise') || baseUrl.includes('business')) {
    return path.replace(/^\/v1\//, '/');
  }
  return path;
}

/**
 * Build a CallLLM function that calls the Copilot API directly (bypassing vscode.lm)
 * so any model available on the Copilot API can be used, including gpt-4.1.
 * onCall is an optional hook called after each LLM call with input/output/model.
 */
export function makeVscodeLLMCaller(
  preferredModel: string,
  cancellationToken: vscode.CancellationToken,
  onCall?: (input: string, output: string, model: string) => void,
): CallLLM {
  return async (systemPrompt: string, userPrompt: string): Promise<{ text: string; usage: LLMUsage }> => {
    const { token, baseUrl } = await getCopilotToken();
    const upstreamPath = normalisePath('/v1/chat/completions', baseUrl);
    const fullUrl = `${baseUrl}${upstreamPath}`;

    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ];

    const response = await fetch(fullUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': `Bearer ${token}`,
        'editor-version': 'vscode/1.95.0',
        'editor-plugin-version': 'copilot/1.0.0',
        'user-agent': 'GithubCopilot/1.0.0',
        'copilot-integration-id': 'vscode-chat',
      },
      body: JSON.stringify({ model: preferredModel, messages, stream: false }),
    });

    if (!response.ok) {
      const errBody = await response.text();
      throw new Error(`Copilot extraction API error: ${response.status} ${response.statusText} — ${errBody.slice(0, 200)}`);
    }

    const data = await response.json() as { choices: Array<{ message: { content: string } }>; usage?: { prompt_tokens?: number; completion_tokens?: number } };
    const text = data?.choices?.[0]?.message?.content ?? '';
    const usage: LLMUsage = {
      inputTokens: data?.usage?.prompt_tokens ?? 0,
      outputTokens: data?.usage?.completion_tokens ?? 0,
    };

    if (onCall) {
      const input = `[SYSTEM]\n${systemPrompt}\n\n[USER]\n${userPrompt}`;
      onCall(input, text, preferredModel);
    }

    return { text, usage };
  };
}

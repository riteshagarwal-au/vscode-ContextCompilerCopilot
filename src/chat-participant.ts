/**
 * chat-participant.ts — Registers the CCC tab in Copilot Chat.
 *
 * The participant intercepts the user's request, runs the full CC2 pipeline
 * to optimise the messages, then calls vscode.lm to get a response and
 * streams it back. The user sees exactly what they'd see in normal Copilot
 * Chat, but with token savings applied transparently.
 */

import * as vscode from 'vscode';
import { runPipeline } from 'context-compiler-typescript';
import { computeStats } from 'context-compiler-typescript';
import { record } from 'context-compiler-typescript';
import { makeVscodeLLMCaller } from './llm-caller';
import type { Message } from 'context-compiler-typescript';
import { showDashboard } from './dashboard';

const PARTICIPANT_ID = 'contextcompiler.ccc';

function getConfig() {
  const cfg = vscode.workspace.getConfiguration('contextCompilerCopilot');
  return {
    enabled: cfg.get<boolean>('enabled', true),
    recentTurns: cfg.get<number>('recentTurns', 3),
    maxToolChars: cfg.get<number>('maxToolChars', 200),
    extractionModel: cfg.get<string>('extractionModel', 'claude-haiku-4.5'),
    logExchanges: cfg.get<boolean>('logExchanges', false),
  };
}

/** Convert VS Code chat history to the Message[] format the pipeline expects. */
function historyToMessages(
  history: readonly vscode.ChatRequestTurn[],
  currentRequest: string,
): Message[] {
  const messages: Message[] = [];

  for (const turn of history) {
    if (turn instanceof vscode.ChatRequestTurn) {
      messages.push({ role: 'user', content: turn.prompt });
    }
  }

  // Add the current user message
  messages.push({ role: 'user', content: currentRequest });
  return messages;
}

export function registerChatParticipant(
  context: vscode.ExtensionContext,
  outputChannel: vscode.OutputChannel,
): void {
  const participant = vscode.chat.createChatParticipant(
    PARTICIPANT_ID,
    async (
      request: vscode.ChatRequest,
      chatContext: vscode.ChatContext,
      stream: vscode.ChatResponseStream,
      token: vscode.CancellationToken,
    ) => {
      const cfg = getConfig();

      // ── Handle slash commands ────────────────────────────────────────────
      if (request.command === 'stats') {
        const stats = computeStats();
        stream.markdown(
          `**Context Compiler Stats**\n\n` +
          `| Metric | Value |\n|---|---|\n` +
          `| Total requests | ${stats.totalRequests.toLocaleString()} |\n` +
          `| Tokens saved | ${stats.totalTokensSaved.toLocaleString()} |\n` +
          `| Avg savings | ${stats.avgSavingsPct}% |\n` +
          `| AI credits saved | ${stats.costSavedCredits.toFixed(4)} |`,
        );
        return;
      }

      if (request.command === 'dashboard') {
        showDashboard(context);
        stream.markdown('Dashboard opened in a new panel.');
        return;
      }

      if (request.command === 'toggle') {
        const current = cfg.enabled;
        await vscode.workspace
          .getConfiguration('contextCompilerCopilot')
          .update('enabled', !current, vscode.ConfigurationTarget.Global);
        stream.markdown(
          `Context Compiler optimisation is now **${!current ? 'enabled' : 'disabled'}**.`,
        );
        return;
      }

      // ── Select model ─────────────────────────────────────────────────────
      const [model] = await vscode.lm.selectChatModels({
        vendor: 'copilot',
        family: request.model?.family,
      });

      if (!model) {
        stream.markdown('No Copilot language model available. Please sign in to GitHub Copilot.');
        return;
      }

      // ── Build messages from history + current prompt ─────────────────────
      const rawMessages = historyToMessages(
        chatContext.history.filter(
          (t): t is vscode.ChatRequestTurn => t instanceof vscode.ChatRequestTurn,
        ),
        request.prompt,
      );

      // ── Run pipeline ─────────────────────────────────────────────────────
      let pipelineResult;
      const headers: Record<string, string> = {};
      const body: Record<string, unknown> = { tools: request.toolInvocationToken ? [{}] : [] };

      if (cfg.enabled) {
        const callLLM = makeVscodeLLMCaller(cfg.extractionModel, token);
        try {
          pipelineResult = await runPipeline({
            messages: rawMessages,
            headers,
            body,
            callLLM,
            recentTurns: cfg.recentTurns,
            maxToolChars: cfg.maxToolChars,
          });
        } catch (err) {
          outputChannel.appendLine(`[ccc] pipeline error: ${err}`);
          pipelineResult = null;
        }
      }

      const optimisedMessages = pipelineResult?.messages ?? rawMessages;
      const lastUserContent = optimisedMessages
        .filter((m) => m.role === 'user')
        .map((m) => (typeof m.content === 'string' ? m.content : ''))
        .at(-1) ?? request.prompt;

      // Show token savings as a progress note if significant
      if (pipelineResult && pipelineResult.tokensBefore - pipelineResult.tokensAfter > 100) {
        const saved = pipelineResult.tokensBefore - pipelineResult.tokensAfter;
        const pct = Math.round((saved / pipelineResult.tokensBefore) * 100);
        stream.progress(`Optimised: saved ${saved.toLocaleString()} tokens (${pct}%)`);
        outputChannel.appendLine(
          `[ccc] ${pipelineResult.mode} | saved ${saved} tokens | removed: ${pipelineResult.removedSections.join(', ')}`,
        );
      }

      // ── Send to model and stream response ────────────────────────────────
      const lmMessages = [
        vscode.LanguageModelChatMessage.User(lastUserContent),
      ];

      const response = await model.sendRequest(lmMessages, {}, token);

      for await (const chunk of response.stream) {
        if (chunk instanceof vscode.LanguageModelTextPart) {
          stream.markdown(chunk.value);
        }
      }

      // ── Observability ─────────────────────────────────────────────────────
      if (cfg.logExchanges && pipelineResult) {
        record({
          ts: new Date().toISOString(),
          mode: pipelineResult.mode,
          tokensBefore: pipelineResult.tokensBefore,
          tokensAfter: pipelineResult.tokensAfter,
          tokensSaved: pipelineResult.tokensBefore - pipelineResult.tokensAfter,
          removedSections: pipelineResult.removedSections,
          model: model.family,
          extractionModel: cfg.extractionModel,
          extractionUsage: pipelineResult.extractionUsage,
        });
      }
    },
  );

  participant.iconPath = new vscode.ThemeIcon('sparkle');
  context.subscriptions.push(participant);

  outputChannel.appendLine(`[cc] CCC chat participant registered (id: ${PARTICIPANT_ID})`);
}

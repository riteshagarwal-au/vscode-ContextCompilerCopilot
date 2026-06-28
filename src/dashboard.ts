/**
 * dashboard.ts — WebView panel showing token-savings stats.
 * Replaces the Python /dashboard HTML endpoint.
 */

import * as vscode from 'vscode';
import { computeStats } from 'context-compiler-typescript';
import type { ModeStats } from 'context-compiler-typescript';

export function showDashboard(context: vscode.ExtensionContext): void {
  const panel = vscode.window.createWebviewPanel(
    'ccDashboard',
    'Context Compiler — Token Savings',
    vscode.ViewColumn.One,
    { enableScripts: false },
  );
  panel.webview.html = buildHtml(computeStats());
}

function pct(n: number): string {
  return n.toFixed(1) + '%';
}

function fmt(n: number): string {
  return n.toLocaleString();
}

function buildHtml(stats: ReturnType<typeof computeStats>): string {
  const modeRows = Object.entries(stats.byMode)
    .map(
      ([mode, v]: [string, ModeStats]) => `
      <tr>
        <td>${mode}</td>
        <td>${fmt(v.requests)}</td>
        <td>${fmt(v.tokensBefore)}</td>
        <td>${fmt(v.tokensAfter)}</td>
        <td>${fmt(v.tokensSaved)}</td>
        <td>${pct(v.avgSavingsPct)}</td>
        <td style="color:#3fb950">${v.costSavedCredits.toFixed(4)}</td>
      </tr>`,
    )
    .join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Context Compiler Dashboard</title>
<style>
  body { font-family: var(--vscode-font-family); background: var(--vscode-editor-background); color: var(--vscode-editor-foreground); padding: 20px; }
  h1 { color: var(--vscode-textLink-foreground); }
  .card { background: var(--vscode-sideBar-background); border-radius: 6px; padding: 16px; margin-bottom: 16px; }
  .metric { display: inline-block; margin-right: 32px; }
  .metric .value { font-size: 2rem; font-weight: bold; color: #3fb950; }
  .metric .label { font-size: 0.8rem; opacity: 0.7; }
  table { width: 100%; border-collapse: collapse; margin-top: 12px; }
  th { text-align: left; padding: 8px; background: var(--vscode-list-hoverBackground); }
  td { padding: 8px; border-bottom: 1px solid var(--vscode-panel-border); }
</style>
</head>
<body>
<h1>Context Compiler — Token Savings</h1>

<div class="card">
  <div class="metric">
    <div class="value">${fmt(stats.totalRequests)}</div>
    <div class="label">Total Requests</div>
  </div>
  <div class="metric">
    <div class="value">${fmt(stats.totalTokensSaved)}</div>
    <div class="label">Tokens Saved</div>
  </div>
  <div class="metric">
    <div class="value">${pct(stats.avgSavingsPct)}</div>
    <div class="label">Avg Savings</div>
  </div>
  <div class="metric">
    <div class="value" style="color:#3fb950">${stats.costSavedCredits.toFixed(4)}</div>
    <div class="label">AI Credits Saved</div>
  </div>
</div>

<div class="card">
  <h3>By Mode</h3>
  <table>
    <thead>
      <tr>
        <th>Mode</th><th>Requests</th><th>Tokens Before</th><th>Tokens After</th>
        <th>Saved</th><th>Avg %</th><th>Credits Saved</th>
      </tr>
    </thead>
    <tbody>${modeRows || '<tr><td colspan="7" style="opacity:0.5">No data yet — start chatting with Copilot!</td></tr>'}</tbody>
  </table>
</div>
</body>
</html>`;
}

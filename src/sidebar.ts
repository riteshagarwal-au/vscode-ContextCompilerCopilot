import * as vscode from 'vscode';
import { computeStats } from 'context-compiler-typescript';

// ── Status view ──────────────────────────────────────────────────────────────

class StatusItem extends vscode.TreeItem {
  constructor(label: string, description: string, iconId: string, contextVal?: string) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.description = description;
    this.iconPath = new vscode.ThemeIcon(iconId);
    if (contextVal) this.contextValue = contextVal;
  }
}

export class StatusViewProvider implements vscode.TreeDataProvider<StatusItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<StatusItem | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private running = false;
  private port = 8181;
  private extractionModel = 'claude-haiku-4.5';

  update(running: boolean, port: number, extractionModel?: string): void {
    this.running = running;
    this.port = port;
    if (extractionModel) this.extractionModel = extractionModel;
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: StatusItem): vscode.TreeItem {
    return element;
  }

  getChildren(): StatusItem[] {
    return [
      new StatusItem(
        'Proxy',
        this.running ? `running on :${this.port}` : 'stopped',
        this.running ? 'circle-filled' : 'circle-outline',
        'ccc.proxy',
      ),
      new StatusItem('Port', String(this.port), 'plug', 'ccc.port'),
      new StatusItem('Mode', this.running ? 'Active' : 'Disabled', this.running ? 'check' : 'x'),
      new StatusItem('Extraction Model', this.extractionModel, 'symbol-enum', 'ccc.extractionModel'),
    ];
  }
}

// ── Stats view ───────────────────────────────────────────────────────────────

class StatsItem extends vscode.TreeItem {
  constructor(label: string, value: string, iconId: string) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.description = value;
    this.iconPath = new vscode.ThemeIcon(iconId);
  }
}

export class StatsViewProvider implements vscode.TreeDataProvider<StatsItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<StatsItem | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: StatsItem): vscode.TreeItem {
    return element;
  }

  getChildren(): StatsItem[] {
    const s = computeStats();
    const saved = s.totalTokensSaved.toLocaleString();
    const pct = s.avgSavingsPct;
    return [
      new StatsItem('Requests', String(s.totalRequests), 'symbol-event'),
      new StatsItem('Tokens saved', saved, 'arrow-down'),
      new StatsItem('Avg reduction', `${pct}%`, 'graph'),
      new StatsItem('Cost saved', `${s.costSavedCredits.toFixed(4)} credits`, 'credit-card'),
    ];
  }
}

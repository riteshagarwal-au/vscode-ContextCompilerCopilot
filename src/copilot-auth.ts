/**
 * copilot-auth.ts — Gets a real Copilot API token using VS Code's built-in
 * GitHub authentication session. Caches the token until 5 minutes before expiry.
 *
 * This replaces the need for Copilot Proxy entirely — the extension already
 * runs in VS Code where the user is signed in to GitHub.
 */

import * as vscode from 'vscode';

interface CopilotToken {
  token: string;
  expiresAt: number; // unix timestamp seconds
  baseUrl: string;
}

let cached: CopilotToken | null = null;

function resolveBaseUrl(token: string): string {
  if (token.includes('proxy-ep=proxy.enterprise.')) {
    return 'https://api.enterprise.githubcopilot.com';
  }
  if (token.includes('proxy-ep=proxy.business.')) {
    return 'https://api.business.githubcopilot.com';
  }
  return 'https://api.githubcopilot.com';
}

function isExpiringSoon(expiresAt: number): boolean {
  // Refresh if less than 5 minutes remaining
  return Date.now() / 1000 > expiresAt - 300;
}

/**
 * Get a valid Copilot API token, refreshing from GitHub if needed.
 * Returns { token, baseUrl } ready to use in Authorization header.
 */
export async function getCopilotToken(): Promise<{ token: string; baseUrl: string }> {
  // Return cached token if still valid
  if (cached && !isExpiringSoon(cached.expiresAt)) {
    return { token: cached.token, baseUrl: cached.baseUrl };
  }

  // Get GitHub OAuth token from VS Code's built-in auth
  // Try silently first (uses existing VS Code GitHub session without a popup)
  let session = await vscode.authentication.getSession(
    'github',
    ['read:user'],
    { silent: true },
  );

  // If no silent session, prompt the user once
  if (!session) {
    session = await vscode.authentication.getSession(
      'github',
      ['read:user'],
      { createIfNone: true },
    );
  }

  if (!session) {
    throw new Error('Not signed in to GitHub. Please sign in via VS Code.');
  }

  const githubToken = session.accessToken;

  // Exchange GitHub token for Copilot session token
  const resp = await fetch('https://api.github.com/copilot_internal/v2/token', {
    headers: {
      Authorization: `token ${githubToken}`,
      'Editor-Version': 'vscode/1.95.0',
      'Editor-Plugin-Version': 'copilot/1.0.0',
      'User-Agent': 'GithubCopilot/1.0.0',
    },
  });

  if (!resp.ok) {
    throw new Error(`Failed to get Copilot token: ${resp.status} ${resp.statusText}`);
  }

  const data = await resp.json() as { token: string; expires_at: number };

  cached = {
    token: data.token,
    expiresAt: data.expires_at,
    baseUrl: resolveBaseUrl(data.token),
  };

  return { token: cached.token, baseUrl: cached.baseUrl };
}

/**
 * Get the raw GitHub OAuth token from VS Code's session.
 * Used for direct GitHub API calls (e.g. copilot_internal/user for quota).
 */
export async function getGitHubToken(): Promise<string> {
  let session = await vscode.authentication.getSession('github', ['read:user'], { silent: true });
  if (!session) {
    session = await vscode.authentication.getSession('github', ['read:user'], { createIfNone: true });
  }
  if (!session) { throw new Error('Not signed in to GitHub.'); }
  return session.accessToken;
}

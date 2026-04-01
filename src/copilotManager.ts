import * as vscode from 'vscode';

import type { CopilotAgentState } from './types.js';

/**
 * Opens the official GitHub Copilot Chat panel and creates a visual agent.
 * No custom agent loop — the user interacts directly with Copilot Chat.
 */
export async function launchCopilotAgent(
  id: number,
  webview: vscode.Webview | undefined,
): Promise<CopilotAgentState | null> {
  // Try known commands to open Copilot Chat panel
  const commands = [
    'workbench.panel.chat.view.copilot.focus',
    'github.copilot.chat.focus',
    'workbench.action.chat.open',
  ];

  let opened = false;
  for (const cmd of commands) {
    try {
      await vscode.commands.executeCommand(cmd);
      opened = true;
      break;
    } catch {
      // Command not available, try next
    }
  }

  if (!opened) {
    vscode.window.showErrorMessage(
      'Pixel Agents: Could not open Copilot Chat. Make sure GitHub Copilot Chat extension is installed.',
    );
    return null;
  }

  const state: CopilotAgentState = { id, isCopilot: true };

  webview?.postMessage({ type: 'agentCreated', id, isCopilot: true });

  return state;
}

/** Focus the Copilot Chat panel (best-effort). */
export async function focusCopilotChat(): Promise<void> {
  const commands = [
    'workbench.panel.chat.view.copilot.focus',
    'github.copilot.chat.focus',
    'workbench.action.chat.open',
  ];
  for (const cmd of commands) {
    try {
      await vscode.commands.executeCommand(cmd);
      return;
    } catch {
      // try next
    }
  }
}

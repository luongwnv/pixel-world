import * as path from 'path';
import * as vscode from 'vscode';

import { USER_IDLE_TIMEOUT_MS } from './constants.js';
import type { UserSyncManager } from './userSyncManager.js';

/** Activity types that map to different character animations */
const ActivityType = {
  TYPING: 'typing',   // Edit, Write, Bash → typing animation
  READING: 'reading',  // Read, Grep, Glob → reading animation
} as const;
type ActivityType = (typeof ActivityType)[keyof typeof ActivityType];

/** Map activity type to tool name for the webview animation system */
function activityToToolStatus(type: ActivityType, detail: string): string {
  switch (type) {
    case ActivityType.TYPING:
      return `Editing ${detail}`;
    case ActivityType.READING:
      return `Reading ${detail}`;
  }
}

/**
 * Tracks user activity in VS Code and sends tool-like messages
 * to the webview so the user's character animates accordingly.
 */
export class UserActivityTracker implements vscode.Disposable {
  private currentToolId: string | null = null;
  private currentActivity: ActivityType | null = null;
  private toolSerial = 0;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private lastStatus = '';
  private subscriptions: vscode.Disposable[] = [];

  private syncManager: UserSyncManager | null = null;

  setSyncManager(syncManager: UserSyncManager): void {
    this.syncManager = syncManager;
  }

  constructor(
    private readonly userAgentId: number,
    private readonly getWebview: () => vscode.Webview | undefined,
    context: vscode.ExtensionContext,
  ) {
    // ── Text editing → TYPING ──
    this.subscriptions.push(
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.contentChanges.length === 0) return;
        const name = path.basename(e.document.fileName);
        this.setActivity(ActivityType.TYPING, name);
      }),
    );

    // ── Switched active editor → READING ──
    this.subscriptions.push(
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (!editor) return;
        const name = path.basename(editor.document.fileName);
        this.setActivity(ActivityType.READING, name);
      }),
    );

    // ── Cursor/click selection → READING (unless currently typing) ──
    this.subscriptions.push(
      vscode.window.onDidChangeTextEditorSelection((e) => {
        if (this.currentActivity === ActivityType.TYPING) return;
        const name = path.basename(e.textEditor.document.fileName);
        this.setActivity(ActivityType.READING, name);
      }),
    );

    // ── Scrolling → READING ──
    this.subscriptions.push(
      vscode.window.onDidChangeTextEditorVisibleRanges((e) => {
        if (this.currentActivity === ActivityType.TYPING) return;
        const name = path.basename(e.textEditor.document.fileName);
        this.setActivity(ActivityType.READING, name);
      }),
    );

    // ── Terminal focus → TYPING ──
    this.subscriptions.push(
      vscode.window.onDidChangeActiveTerminal((terminal) => {
        if (terminal) {
          this.setActivity(ActivityType.TYPING, 'terminal');
        }
      }),
    );

    // ── File save → TYPING ──
    this.subscriptions.push(
      vscode.workspace.onDidSaveTextDocument((doc) => {
        const name = path.basename(doc.fileName);
        this.setActivity(ActivityType.TYPING, name);
      }),
    );

    // Add to extension context for proper cleanup
    context.subscriptions.push(...this.subscriptions);

    // Start as idle (wander)
    this.post({ type: 'agentStatus', id: this.userAgentId, status: 'waiting' });
    console.log(`[UserActivity] Tracker created for agent ${this.userAgentId}`);
  }

  private post(msg: Record<string, unknown>): void {
    const webview = this.getWebview();
    if (!webview) {
      console.log(`[UserActivity] ⚠ No webview for:`, msg.type);
      return;
    }
    webview.postMessage(msg);
  }

  private setActivity(type: ActivityType, detail: string): void {
    const id = this.userAgentId;
    const status = activityToToolStatus(type, detail);

    // Same status — just reset idle timer
    if (status === this.lastStatus && this.currentToolId) {
      this.resetIdleTimer();
      return;
    }

    const isFirstActivity = this.currentActivity === null;
    const activityTypeChanged = !isFirstActivity && this.currentActivity !== type;
    this.lastStatus = status;
    this.currentActivity = type;

    // End previous tool
    if (this.currentToolId) {
      this.post({ type: 'agentToolDone', id, toolId: this.currentToolId });
    }

    // On first activity or activity TYPE change, reassign seat and walk
    if (isFirstActivity || activityTypeChanged) {
      const preferDesk = type === ActivityType.TYPING;
      this.post({ type: 'agentToolsClear', id });
      this.post({ type: 'userActivityChange', id, preferDesk });
    }

    // Start new tool
    const toolId = `user-${++this.toolSerial}`;
    this.currentToolId = toolId;
    console.log(`[UserActivity] ${type}: ${status}`);
    this.post({ type: 'agentToolStart', id, toolId, status });
    this.syncManager?.updateLocalActivity(status, type);

    this.resetIdleTimer();
  }

  private resetIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (this.currentToolId) {
        this.post({ type: 'agentToolDone', id: this.userAgentId, toolId: this.currentToolId });
        this.currentToolId = null;
      }
      this.currentActivity = null;
      this.lastStatus = '';
      this.post({ type: 'agentToolsClear', id: this.userAgentId });
      this.post({ type: 'agentStatus', id: this.userAgentId, status: 'waiting' });
      this.syncManager?.updateLocalActivity('', '');
      console.log(`[UserActivity] → idle (wander)`);
    }, USER_IDLE_TIMEOUT_MS);
  }

  dispose(): void {
    for (const s of this.subscriptions) s.dispose();
    this.subscriptions = [];
    if (this.idleTimer) clearTimeout(this.idleTimer);
  }
}

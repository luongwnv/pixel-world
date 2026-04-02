import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

import { LAYOUT_FILE_DIR } from './constants.js';

const USERS_FILE_NAME = 'users.json';
const SYNC_POLL_INTERVAL_MS = 500;
const STALE_TIMEOUT_MS = 300_000;

export interface UserEntry {
  windowName: string;
  activity: string; // e.g. "Editing constants.ts", "" = idle
  activityType: 'typing' | 'reading' | '';
  timestamp: number;
}

type UsersFile = Record<string, UserEntry>;

function getUsersFilePath(): string {
  return path.join(os.homedir(), LAYOUT_FILE_DIR, USERS_FILE_NAME);
}

/**
 * Manages cross-window user character synchronization via a shared JSON file.
 * Each VS Code window writes its own activity; polls for other windows' activities.
 */
export class UserSyncManager implements vscode.Disposable {
  private readonly windowId: string;
  private readonly windowName: string;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private knownRemoteIds = new Map<string, number>(); // windowId → agentId
  private nextRemoteId: { current: number };
  private disposed = false;

  /** Last written entry — used for heartbeat refreshes */
  private lastEntry: UserEntry | null = null;

  constructor(
    private readonly getWebview: () => vscode.Webview | undefined,
    nextAgentIdRef: { current: number },
  ) {
    this.windowId = crypto.randomUUID();
    this.windowName =
      vscode.workspace.workspaceFolders?.[0]?.name ?? path.basename(process.cwd());
    this.nextRemoteId = nextAgentIdRef;

    // Heartbeat: refresh own timestamp every 5s so we don't go stale
    this.heartbeat();
    this.heartbeatTimer = setInterval(() => this.heartbeat(), 5000);

    // Poll for remote users every 500ms
    this.pollTimer = setInterval(() => this.poll(), SYNC_POLL_INTERVAL_MS);

    console.log(`[UserSync] Started for window "${this.windowName}" (${this.windowId})`);
  }

  /** Called by UserActivityTracker when local activity changes */
  updateLocalActivity(activity: string, activityType: 'typing' | 'reading' | ''): void {
    const entry: UserEntry = {
      windowName: this.windowName,
      activity,
      activityType,
      timestamp: Date.now(),
    };
    this.lastEntry = entry;
    this.writeEntry(entry);
  }

  /**
   * Reset remote state so all remote users are re-created on next poll.
   * Must be called when the webview is recreated (e.g. panel collapse/expand).
   */
  resetRemoteState(): void {
    this.knownRemoteIds.clear();
    console.log('[UserSync] Remote state reset (webview recreated)');
  }

  /** Refresh timestamp periodically so other windows don't consider us stale */
  private heartbeat(): void {
    if (!this.lastEntry) {
      // No activity yet — write idle entry
      this.lastEntry = {
        windowName: this.windowName,
        activity: '',
        activityType: '',
        timestamp: Date.now(),
      };
    } else {
      this.lastEntry.timestamp = Date.now();
    }
    this.writeEntry(this.lastEntry);
  }

  private writeEntry(entry: UserEntry): void {
    const filePath = getUsersFilePath();
    try {
      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      let data: UsersFile = {};
      if (fs.existsSync(filePath)) {
        try {
          data = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as UsersFile;
        } catch {
          data = {};
        }
      }

      data[this.windowId] = entry;

      // Clean stale entries while writing
      const now = Date.now();
      for (const [id, e] of Object.entries(data)) {
        if (now - e.timestamp > STALE_TIMEOUT_MS) {
          delete data[id];
        }
      }

      const tmpPath = `${filePath}.${this.windowId}.tmp`;
      fs.writeFileSync(tmpPath, JSON.stringify(data), 'utf-8');
      fs.renameSync(tmpPath, filePath);
    } catch (err) {
      console.error('[UserSync] Write error:', err);
    }
  }

  private poll(): void {
    if (this.disposed) return;
    const filePath = getUsersFilePath();
    let data: UsersFile = {};
    try {
      if (!fs.existsSync(filePath)) return;
      data = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as UsersFile;
    } catch {
      return;
    }

    const webview = this.getWebview();
    if (!webview) return;

    const now = Date.now();
    const activeRemoteIds = new Set<string>();

    for (const [winId, entry] of Object.entries(data)) {
      if (winId === this.windowId) continue; // skip self
      if (now - entry.timestamp > STALE_TIMEOUT_MS) continue; // stale

      activeRemoteIds.add(winId);

      if (!this.knownRemoteIds.has(winId)) {
        // New remote user — create character
        const agentId = this.nextRemoteId.current++;
        this.knownRemoteIds.set(winId, agentId);
        webview.postMessage({
          type: 'agentCreated',
          id: agentId,
          isUser: true,
          isRemoteUser: true,
          windowName: entry.windowName,
        });
        console.log(`[UserSync] Remote user "${entry.windowName}" created as agent ${agentId}`);
      }

      const agentId = this.knownRemoteIds.get(winId)!;

      // Send activity update
      if (entry.activity) {
        webview.postMessage({
          type: 'agentToolStart',
          id: agentId,
          toolId: `remote-${winId}-${entry.timestamp}`,
          status: entry.activity,
        });
      } else {
        webview.postMessage({ type: 'agentToolsClear', id: agentId });
        webview.postMessage({ type: 'agentStatus', id: agentId, status: 'waiting' });
      }
    }

    // Remove stale remote users
    for (const [winId, agentId] of this.knownRemoteIds) {
      if (!activeRemoteIds.has(winId)) {
        webview.postMessage({ type: 'agentClosed', id: agentId });
        this.knownRemoteIds.delete(winId);
        console.log(`[UserSync] Remote user ${agentId} removed (stale)`);
      }
    }
  }

  /** Remove own entry from shared file */
  private removeOwnEntry(): void {
    const filePath = getUsersFilePath();
    try {
      if (!fs.existsSync(filePath)) return;
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as UsersFile;
      delete data[this.windowId];
      const tmpPath = `${filePath}.${this.windowId}.tmp`;
      fs.writeFileSync(tmpPath, JSON.stringify(data), 'utf-8');
      fs.renameSync(tmpPath, filePath);
    } catch {
      /* ignore */
    }
  }

  dispose(): void {
    this.disposed = true;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.removeOwnEntry();
  }
}

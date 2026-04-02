import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

import {
  AGENT_SYNC_FILE_NAME,
  AGENT_SYNC_POLL_INTERVAL_MS,
  AGENT_SYNC_STALE_TIMEOUT_MS,
  LAYOUT_FILE_DIR,
} from './constants.js';
import type { AgentState } from './types.js';

interface SyncedAgent {
  palette: number;
  hueShift: number;
  seatId: string | null;
  toolStatus: string | null;
  isWaiting: boolean;
  folderName?: string;
}

interface WindowEntry {
  windowName: string;
  timestamp: number;
  agents: Record<string, SyncedAgent>;
}

type AgentsFile = Record<string, WindowEntry>;

function getAgentsFilePath(): string {
  return path.join(os.homedir(), LAYOUT_FILE_DIR, AGENT_SYNC_FILE_NAME);
}

/**
 * Manages cross-window agent character synchronization via a shared JSON file.
 * Each VS Code window writes its own agents' metadata; polls for other windows' agents.
 */
export class AgentSyncManager implements vscode.Disposable {
  private readonly windowId: string;
  private readonly windowName: string;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private disposed = false;

  /** Remote agent tracking: "windowId:originalId" → local agent ID */
  private knownRemoteAgents = new Map<string, number>();
  /** Track last seen tool status per remote agent to avoid redundant messages */
  private lastToolStatus = new Map<string, string | null>();
  private lastWaiting = new Map<string, boolean>();

  /** Local agent metadata (updated by saveAgentSeats from webview) */
  private localAgentMeta: Record<
    number,
    { palette: number; hueShift: number; seatId: string | null }
  > = {};

  constructor(
    private readonly getWebview: () => vscode.Webview | undefined,
    private readonly getAgents: () => Map<number, AgentState>,
    private readonly nextAgentIdRef: { current: number },
  ) {
    this.windowId = crypto.randomUUID();
    this.windowName =
      vscode.workspace.workspaceFolders?.[0]?.name ?? path.basename(process.cwd());

    // Write immediately, then poll
    this.writeLocalAgents();
    this.pollTimer = setInterval(() => {
      this.writeLocalAgents();
      this.poll();
    }, AGENT_SYNC_POLL_INTERVAL_MS);

    console.log(`[AgentSync] Started for window "${this.windowName}" (${this.windowId})`);
  }

  /** Called when webview sends saveAgentSeats */
  updateAgentMeta(
    seats: Record<number, { palette: number; hueShift: number; seatId: string | null }>,
  ): void {
    this.localAgentMeta = seats;
    this.writeLocalAgents();
  }

  /** Force-write current state (e.g. after agent create/remove) */
  sync(): void {
    this.writeLocalAgents();
  }

  /**
   * Reset remote state so all remote agents are re-created on next poll.
   * Must be called when the webview is recreated (e.g. panel collapse/expand).
   */
  resetRemoteState(): void {
    this.knownRemoteAgents.clear();
    this.lastToolStatus.clear();
    this.lastWaiting.clear();
    console.log('[AgentSync] Remote state reset (webview recreated)');
  }

  private writeLocalAgents(): void {
    const filePath = getAgentsFilePath();
    const agents = this.getAgents();

    const syncedAgents: Record<string, SyncedAgent> = {};
    for (const [id, agent] of agents) {
      const meta = this.localAgentMeta[id];
      // Get current tool status (most recent)
      let toolStatus: string | null = null;
      if (agent.activeToolStatuses.size > 0) {
        const statuses = [...agent.activeToolStatuses.values()];
        toolStatus = statuses[statuses.length - 1];
      }

      syncedAgents[String(id)] = {
        palette: meta?.palette ?? 0,
        hueShift: meta?.hueShift ?? 0,
        seatId: meta?.seatId ?? null,
        toolStatus,
        isWaiting: agent.isWaiting,
        folderName: agent.folderName,
      };
    }

    try {
      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      let data: AgentsFile = {};
      if (fs.existsSync(filePath)) {
        try {
          data = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as AgentsFile;
        } catch {
          // If parse fails (race condition with another window writing),
          // only write our own entry — don't wipe others
          data = {};
        }
      }

      data[this.windowId] = {
        windowName: this.windowName,
        timestamp: Date.now(),
        agents: syncedAgents,
      };

      // Clean stale entries
      const now = Date.now();
      for (const [id, entry] of Object.entries(data)) {
        if (now - entry.timestamp > AGENT_SYNC_STALE_TIMEOUT_MS) {
          delete data[id];
        }
      }

      // Use a unique tmp path per window to avoid race conditions
      const tmpPath = `${filePath}.${this.windowId}.tmp`;
      fs.writeFileSync(tmpPath, JSON.stringify(data), 'utf-8');
      fs.renameSync(tmpPath, filePath);
    } catch (err) {
      console.error('[AgentSync] Write error:', err);
    }
  }

  private poll(): void {
    if (this.disposed) return;
    const filePath = getAgentsFilePath();
    let data: AgentsFile = {};
    try {
      if (!fs.existsSync(filePath)) return;
      data = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as AgentsFile;
    } catch {
      // Parse failed — skip this poll, keep existing remote agents
      return;
    }

    const webview = this.getWebview();
    if (!webview) return;

    const now = Date.now();
    const activeRemoteKeys = new Set<string>();

    for (const [winId, entry] of Object.entries(data)) {
      if (winId === this.windowId) continue;
      if (now - entry.timestamp > AGENT_SYNC_STALE_TIMEOUT_MS) continue;

      for (const [origId, agentInfo] of Object.entries(entry.agents)) {
        const key = `${winId}:${origId}`;
        activeRemoteKeys.add(key);

        if (!this.knownRemoteAgents.has(key)) {
          // New remote agent — create character
          const localId = this.nextAgentIdRef.current++;
          this.knownRemoteAgents.set(key, localId);
          webview.postMessage({
            type: 'agentCreated',
            id: localId,
            isRemoteAgent: true,
            palette: agentInfo.palette,
            hueShift: agentInfo.hueShift,
            windowName: entry.windowName,
            folderName: agentInfo.folderName,
          });
          console.log(
            `[AgentSync] Remote agent "${key}" created as local ${localId} (palette=${agentInfo.palette}, hueShift=${agentInfo.hueShift})`,
          );
        }

        const localId = this.knownRemoteAgents.get(key)!;

        // Update tool status
        const prevTool = this.lastToolStatus.get(key);
        if (agentInfo.toolStatus !== prevTool) {
          this.lastToolStatus.set(key, agentInfo.toolStatus);
          if (agentInfo.toolStatus) {
            webview.postMessage({
              type: 'agentToolStart',
              id: localId,
              toolId: `remote-${key}-${now}`,
              status: agentInfo.toolStatus,
            });
          } else {
            webview.postMessage({ type: 'agentToolsClear', id: localId });
          }
        }

        // Update waiting status
        const prevWaiting = this.lastWaiting.get(key) ?? false;
        if (agentInfo.isWaiting !== prevWaiting) {
          this.lastWaiting.set(key, agentInfo.isWaiting);
          webview.postMessage({
            type: 'agentStatus',
            id: localId,
            status: agentInfo.isWaiting ? 'waiting' : 'active',
          });
        }
      }
    }

    // Remove stale remote agents
    for (const [key, localId] of this.knownRemoteAgents) {
      if (!activeRemoteKeys.has(key)) {
        webview.postMessage({ type: 'agentClosed', id: localId });
        this.knownRemoteAgents.delete(key);
        this.lastToolStatus.delete(key);
        this.lastWaiting.delete(key);
        console.log(`[AgentSync] Remote agent ${localId} (${key}) removed (stale)`);
      }
    }
  }

  /** Remove own entry from shared file */
  private removeOwnEntry(): void {
    const filePath = getAgentsFilePath();
    try {
      if (!fs.existsSync(filePath)) return;
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as AgentsFile;
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
    this.removeOwnEntry();
  }
}

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

import {
  createPendingClaudeAgent,
  getProjectDirPath,
  persistAgents,
  removeAgent,
  restoreAgents,
  sendExistingAgents,
  sendLayout,
} from './agentManager.js';
import { AgentSyncManager } from './agentSyncManager.js';
import {
  loadCharacterSprites,
  loadDefaultLayout,
  loadFloorTiles,
  loadFurnitureAssets,
  loadWallTiles,
  sendAssetsToWebview,
  sendCharacterSpritesToWebview,
  sendFloorTilesToWebview,
  sendWallTilesToWebview,
} from './assetLoader.js';
import {
  GLOBAL_KEY_SOUND_ENABLED,
  LAYOUT_REVISION_KEY,
  WORKSPACE_KEY_AGENT_SEATS,
} from './constants.js';
import { focusCopilotChat, launchCopilotAgent } from './copilotManager.js';
import { ensureProjectScan } from './fileWatcher.js';
import type { LayoutWatcher } from './layoutPersistence.js';
import { readLayoutFromFile, watchLayoutFile, writeLayoutToFile } from './layoutPersistence.js';
import type { AgentState, CopilotAgentState } from './types.js';
import { UserActivityTracker } from './userActivityTracker.js';
import { UserSyncManager } from './userSyncManager.js';

export class PixelAgentsViewProvider implements vscode.WebviewViewProvider {
  nextAgentId = { current: 1 };
  nextTerminalIndex = { current: 1 };
  agents = new Map<number, AgentState>();
  copilotAgents = new Map<number, CopilotAgentState>();
  webviewView: vscode.WebviewView | undefined;

  // Per-agent timers
  fileWatchers = new Map<number, fs.FSWatcher>();
  pollingTimers = new Map<number, ReturnType<typeof setInterval>>();
  waitingTimers = new Map<number, ReturnType<typeof setTimeout>>();
  jsonlPollTimers = new Map<number, ReturnType<typeof setInterval>>();
  permissionTimers = new Map<number, ReturnType<typeof setTimeout>>();

  // /clear detection: project-level scan for new JSONL files
  activeAgentId = { current: null as number | null };
  knownJsonlFiles = new Set<string>();
  projectScanTimer = { current: null as ReturnType<typeof setInterval> | null };

  // Bundled default layout (loaded from assets/default-layout.json)
  defaultLayout: Record<string, unknown> | null = null;

  // Cross-window layout sync
  layoutWatcher: LayoutWatcher | null = null;

  // Cross-window agent sync
  agentSyncManager: AgentSyncManager | null = null;

  // User activity tracking
  userActivityTracker: UserActivityTracker | null = null;
  userSyncManager: UserSyncManager | null = null;
  userAgentId: number | null = null;

  constructor(private readonly context: vscode.ExtensionContext) {}

  private get extensionUri(): vscode.Uri {
    return this.context.extensionUri;
  }

  private get webview(): vscode.Webview | undefined {
    return this.webviewView?.webview;
  }

  private persistAgents = (): void => {
    persistAgents(this.agents, this.context);
    this.agentSyncManager?.sync();
  };

  resolveWebviewView(webviewView: vscode.WebviewView) {
    this.webviewView = webviewView;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = getWebviewContent(webviewView.webview, this.extensionUri);

    webviewView.webview.onDidReceiveMessage(async (message) => {
      if (message.type === 'openCopilot') {
        const id = this.nextAgentId.current++;
        this.nextTerminalIndex.current++;
        const state = await launchCopilotAgent(id, this.webview);
        if (state) {
          this.copilotAgents.set(id, state);
        }
      } else if (message.type === 'openClaude') {
        createPendingClaudeAgent(
          this.nextAgentId,
          this.nextTerminalIndex,
          this.agents,
          this.activeAgentId,
          this.knownJsonlFiles,
          this.fileWatchers,
          this.pollingTimers,
          this.waitingTimers,
          this.permissionTimers,
          this.projectScanTimer,
          this.webview,
          this.persistAgents,
          message.folderPath as string | undefined,
        );
        // Try to open Claude Code panel
        void this.openClaudeCodePanel();
      } else if (message.type === 'focusAgent') {
        const agent = this.agents.get(message.id);
        const copilot = this.copilotAgents.get(message.id);
        if (agent) {
          if (agent.terminalRef) {
            agent.terminalRef.show();
          } else {
            void this.openClaudeCodePanel();
          }
        } else if (copilot) {
          void focusCopilotChat();
        }
      } else if (message.type === 'closeAgent') {
        const agent = this.agents.get(message.id);
        const copilot = this.copilotAgents.get(message.id);
        if (agent) {
          if (agent.terminalRef) {
            agent.terminalRef.dispose();
          } else {
            removeAgent(
              message.id as number,
              this.agents,
              this.fileWatchers,
              this.pollingTimers,
              this.waitingTimers,
              this.permissionTimers,
              this.jsonlPollTimers,
              this.persistAgents,
            );
            this.webview?.postMessage({ type: 'agentClosed', id: message.id });
          }
        } else if (copilot) {
          this.copilotAgents.delete(message.id);
          this.webview?.postMessage({ type: 'agentClosed', id: message.id });
        }
      } else if (message.type === 'saveAgentSeats') {
        // Store seat assignments in a separate key (never touched by persistAgents)
        console.log(`[Pixel Agents] saveAgentSeats:`, JSON.stringify(message.seats));
        this.context.workspaceState.update(WORKSPACE_KEY_AGENT_SEATS, message.seats);
        this.agentSyncManager?.updateAgentMeta(message.seats as Record<number, { palette: number; hueShift: number; seatId: string | null }>);
      } else if (message.type === 'saveLayout') {
        this.layoutWatcher?.markOwnWrite();
        writeLayoutToFile(message.layout as Record<string, unknown>);
      } else if (message.type === 'setSoundEnabled') {
        this.context.globalState.update(GLOBAL_KEY_SOUND_ENABLED, message.enabled);
      } else if (message.type === 'webviewReady') {
        restoreAgents(
          this.context,
          this.nextAgentId,
          this.nextTerminalIndex,
          this.agents,
          this.knownJsonlFiles,
          this.fileWatchers,
          this.pollingTimers,
          this.waitingTimers,
          this.permissionTimers,
          this.jsonlPollTimers,
          this.projectScanTimer,
          this.activeAgentId,
          this.webview,
          this.persistAgents,
        );
        // Send persisted settings to webview
        const soundEnabled = this.context.globalState.get<boolean>(GLOBAL_KEY_SOUND_ENABLED, true);
        this.webview?.postMessage({ type: 'settingsLoaded', soundEnabled });

        // Send workspace folders to webview (only when multi-root)
        const wsFolders = vscode.workspace.workspaceFolders;
        if (wsFolders && wsFolders.length > 1) {
          this.webview?.postMessage({
            type: 'workspaceFolders',
            folders: wsFolders.map((f) => ({ name: f.name, path: f.uri.fsPath })),
          });
        }

        // Ensure project scan runs even with no restored agents (to adopt external terminals)
        const projectDir = getProjectDirPath();
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        console.log('[Extension] workspaceRoot:', workspaceRoot);
        console.log('[Extension] projectDir:', projectDir);
        if (projectDir) {
          ensureProjectScan(
            projectDir,
            this.knownJsonlFiles,
            this.projectScanTimer,
            this.activeAgentId,
            this.nextAgentId,
            this.agents,
            this.fileWatchers,
            this.pollingTimers,
            this.waitingTimers,
            this.permissionTimers,
            this.webview,
            this.persistAgents,
          );

          // Load furniture assets BEFORE sending layout
          (async () => {
            try {
              console.log('[Extension] Loading furniture assets...');
              const extensionPath = this.extensionUri.fsPath;
              console.log('[Extension] extensionPath:', extensionPath);

              // Check bundled location first: extensionPath/dist/assets/
              const bundledAssetsDir = path.join(extensionPath, 'dist', 'assets');
              let assetsRoot: string | null = null;
              if (fs.existsSync(bundledAssetsDir)) {
                console.log('[Extension] Found bundled assets at dist/');
                assetsRoot = path.join(extensionPath, 'dist');
              } else if (workspaceRoot) {
                // Fall back to workspace root (development or external assets)
                console.log('[Extension] Trying workspace for assets...');
                assetsRoot = workspaceRoot;
              }

              if (!assetsRoot) {
                console.log('[Extension] ⚠️  No assets directory found');
                if (this.webview) {
                  sendLayout(this.context, this.webview, this.defaultLayout);
                  this.startLayoutWatcher();
                }
                return;
              }

              console.log('[Extension] Using assetsRoot:', assetsRoot);

              // Load bundled default layout
              this.defaultLayout = loadDefaultLayout(assetsRoot);

              // Load character sprites
              const charSprites = await loadCharacterSprites(assetsRoot);
              if (charSprites && this.webview) {
                console.log('[Extension] Character sprites loaded, sending to webview');
                sendCharacterSpritesToWebview(this.webview, charSprites);
              }

              // Load floor tiles
              const floorTiles = await loadFloorTiles(assetsRoot);
              if (floorTiles && this.webview) {
                console.log('[Extension] Floor tiles loaded, sending to webview');
                sendFloorTilesToWebview(this.webview, floorTiles);
              }

              // Load wall tiles
              const wallTiles = await loadWallTiles(assetsRoot);
              if (wallTiles && this.webview) {
                console.log('[Extension] Wall tiles loaded, sending to webview');
                sendWallTilesToWebview(this.webview, wallTiles);
              }

              const assets = await loadFurnitureAssets(assetsRoot);
              if (assets && this.webview) {
                console.log('[Extension] ✅ Assets loaded, sending to webview');
                sendAssetsToWebview(this.webview, assets);
              }
            } catch (err) {
              console.error('[Extension] ❌ Error loading assets:', err);
            }
            // Always send saved layout (or null for default)
            if (this.webview) {
              console.log('[Extension] Sending saved layout');
              sendLayout(this.context, this.webview, this.defaultLayout);
              this.startLayoutWatcher();
            }
          })();
        } else {
          // No project dir — still try to load floor/wall tiles, then send saved layout
          (async () => {
            try {
              const ep = this.extensionUri.fsPath;
              const bundled = path.join(ep, 'dist', 'assets');
              if (fs.existsSync(bundled)) {
                const distRoot = path.join(ep, 'dist');
                this.defaultLayout = loadDefaultLayout(distRoot);
                const cs = await loadCharacterSprites(distRoot);
                if (cs && this.webview) {
                  sendCharacterSpritesToWebview(this.webview, cs);
                }
                const ft = await loadFloorTiles(distRoot);
                if (ft && this.webview) {
                  sendFloorTilesToWebview(this.webview, ft);
                }
                const wt = await loadWallTiles(distRoot);
                if (wt && this.webview) {
                  sendWallTilesToWebview(this.webview, wt);
                }
              }
            } catch {
              /* ignore */
            }
            if (this.webview) {
              sendLayout(this.context, this.webview, this.defaultLayout);
              this.startLayoutWatcher();
            }
          })();
        }
        sendExistingAgents(this.agents, this.context, this.webview);

        // Create (or re-create) the user character on every webview ready
        this.userActivityTracker?.dispose();
        this.userAgentId = this.nextAgentId.current++;
        this.nextTerminalIndex.current++;
        this.webview?.postMessage({
          type: 'agentCreated',
          id: this.userAgentId,
          isUser: true,
        });
        this.userActivityTracker = new UserActivityTracker(
          this.userAgentId,
          () => this.webview,
          this.context,
        );

        // Cross-window user sync (create once, reuse across webview reloads)
        if (!this.userSyncManager) {
          this.userSyncManager = new UserSyncManager(
            () => this.webview,
            this.nextAgentId,
          );
        } else {
          // Webview was recreated — reset remote state so remote users
          // are re-created on next poll
          this.userSyncManager.resetRemoteState();
        }
        this.userActivityTracker.setSyncManager(this.userSyncManager);

        // Cross-window agent sync (create once, reuse across webview reloads)
        if (!this.agentSyncManager) {
          this.agentSyncManager = new AgentSyncManager(
            () => this.webview,
            () => this.agents,
            this.nextAgentId,
          );
        } else {
          // Webview was recreated (panel collapse/expand) — reset remote state
          // so all remote agents are re-created on next poll
          this.agentSyncManager.resetRemoteState();
        }
      } else if (message.type === 'openSessionsFolder') {
        const projectDir = getProjectDirPath();
        if (projectDir && fs.existsSync(projectDir)) {
          vscode.env.openExternal(vscode.Uri.file(projectDir));
        }
      } else if (message.type === 'exportLayout') {
        const layout = readLayoutFromFile();
        if (!layout) {
          vscode.window.showWarningMessage('Pixel Agents: No saved layout to export.');
          return;
        }
        const uri = await vscode.window.showSaveDialog({
          filters: { 'JSON Files': ['json'] },
          defaultUri: vscode.Uri.file(path.join(os.homedir(), 'pixel-agents-layout.json')),
        });
        if (uri) {
          fs.writeFileSync(uri.fsPath, JSON.stringify(layout, null, 2), 'utf-8');
          vscode.window.showInformationMessage('Pixel Agents: Layout exported successfully.');
        }
      } else if (message.type === 'importLayout') {
        const uris = await vscode.window.showOpenDialog({
          filters: { 'JSON Files': ['json'] },
          canSelectMany: false,
        });
        if (!uris || uris.length === 0) return;
        try {
          const raw = fs.readFileSync(uris[0].fsPath, 'utf-8');
          const imported = JSON.parse(raw) as Record<string, unknown>;
          if (imported.version !== 1 || !Array.isArray(imported.tiles)) {
            vscode.window.showErrorMessage('Pixel Agents: Invalid layout file.');
            return;
          }
          this.layoutWatcher?.markOwnWrite();
          writeLayoutToFile(imported);
          this.webview?.postMessage({ type: 'layoutLoaded', layout: imported });
          vscode.window.showInformationMessage('Pixel Agents: Layout imported successfully.');
        } catch {
          vscode.window.showErrorMessage('Pixel Agents: Failed to read or parse layout file.');
        }
      }
    });

    vscode.window.onDidChangeActiveTerminal((terminal) => {
      if (!terminal) return;
      for (const [id, agent] of this.agents) {
        if (agent.terminalRef && agent.terminalRef === terminal) {
          this.activeAgentId.current = id;
          webviewView.webview.postMessage({ type: 'agentSelected', id });
          return;
        }
      }
    });

    vscode.window.onDidCloseTerminal((closed) => {
      for (const [id, agent] of this.agents) {
        if (agent.terminalRef && agent.terminalRef === closed) {
          if (this.activeAgentId.current === id) {
            this.activeAgentId.current = null;
          }
          removeAgent(
            id,
            this.agents,
            this.fileWatchers,
            this.pollingTimers,
            this.waitingTimers,
            this.permissionTimers,
            this.jsonlPollTimers,
            this.persistAgents,
          );
          webviewView.webview.postMessage({ type: 'agentClosed', id });
        }
      }
    });
  }

  /** Export current saved layout as a versioned default-layout-{N}.json (dev utility) */
  exportDefaultLayout(): void {
    const layout = readLayoutFromFile();
    if (!layout) {
      vscode.window.showWarningMessage('Pixel Agents: No saved layout found.');
      return;
    }
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) {
      vscode.window.showErrorMessage('Pixel Agents: No workspace folder found.');
      return;
    }
    const assetsDir = path.join(workspaceRoot, 'webview-ui', 'public', 'assets');

    // Find the next revision number
    let maxRevision = 0;
    if (fs.existsSync(assetsDir)) {
      for (const file of fs.readdirSync(assetsDir)) {
        const match = /^default-layout-(\d+)\.json$/.exec(file);
        if (match) {
          maxRevision = Math.max(maxRevision, parseInt(match[1], 10));
        }
      }
    }
    const nextRevision = maxRevision + 1;
    layout[LAYOUT_REVISION_KEY] = nextRevision;

    const targetPath = path.join(assetsDir, `default-layout-${nextRevision}.json`);
    const json = JSON.stringify(layout, null, 2);
    fs.writeFileSync(targetPath, json, 'utf-8');
    vscode.window.showInformationMessage(
      `Pixel Agents: Default layout exported as revision ${nextRevision} to ${targetPath}`,
    );
  }

  private async openClaudeCodePanel(): Promise<void> {
    const commands = [
      'claude-code.focus',
      'workbench.panel.chat.view.claude-dev.focus',
      'claude-dev.plusButtonClicked',
      'workbench.action.chat.open',
    ];
    for (const cmd of commands) {
      try {
        await vscode.commands.executeCommand(cmd);
        return;
      } catch {
        // Command not available, try next
      }
    }
  }

  private startLayoutWatcher(): void {
    if (this.layoutWatcher) return;
    this.layoutWatcher = watchLayoutFile((layout) => {
      console.log('[Pixel Agents] External layout change — pushing to webview');
      this.webview?.postMessage({ type: 'layoutLoaded', layout });
    });
  }

  dispose() {
    this.agentSyncManager?.dispose();
    this.agentSyncManager = null;
    this.userActivityTracker?.dispose();
    this.userActivityTracker = null;
    this.userSyncManager?.dispose();
    this.userSyncManager = null;
    this.layoutWatcher?.dispose();
    this.layoutWatcher = null;
    this.copilotAgents.clear();
    for (const id of [...this.agents.keys()]) {
      removeAgent(
        id,
        this.agents,
        this.fileWatchers,
        this.pollingTimers,
        this.waitingTimers,
        this.permissionTimers,
        this.jsonlPollTimers,
        this.persistAgents,
      );
    }
    if (this.projectScanTimer.current) {
      clearInterval(this.projectScanTimer.current);
      this.projectScanTimer.current = null;
    }
  }
}

export function getWebviewContent(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const distPath = vscode.Uri.joinPath(extensionUri, 'dist', 'webview');
  const indexPath = vscode.Uri.joinPath(distPath, 'index.html').fsPath;

  let html = fs.readFileSync(indexPath, 'utf-8');

  html = html.replace(/(href|src)="\.\/([^"]+)"/g, (_match, attr, filePath) => {
    const fileUri = vscode.Uri.joinPath(distPath, filePath);
    const webviewUri = webview.asWebviewUri(fileUri);
    return `${attr}="${webviewUri}"`;
  });

  return html;
}

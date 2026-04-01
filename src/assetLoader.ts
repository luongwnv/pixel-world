/**
 * Asset Loader - Loads furniture assets from per-folder manifests
 *
 * Scans assets/furniture/ subdirectories, reads each manifest.json,
 * and loads all PNG files into SpriteData format for use in the webview.
 */

import * as fs from 'fs';
import * as path from 'path';
import { PNG } from 'pngjs';
import * as vscode from 'vscode';

import {
  CHAR_COUNT,
  CHAR_FRAME_H,
  CHAR_FRAME_W,
  CHAR_FRAMES_PER_ROW,
  CHARACTER_DIRECTIONS,
  FLOOR_TILE_SIZE,
  LAYOUT_REVISION_KEY,
  PNG_ALPHA_THRESHOLD,
  WALL_BITMASK_COUNT,
  WALL_GRID_COLS,
  WALL_PIECE_HEIGHT,
  WALL_PIECE_WIDTH,
} from './constants.js';

export interface FurnitureAsset {
  id: string;
  name: string;
  label: string;
  category: string;
  file: string;
  width: number;
  height: number;
  footprintW: number;
  footprintH: number;
  isDesk: boolean;
  canPlaceOnWalls: boolean;
  groupId?: string;
  canPlaceOnSurfaces?: boolean;
  backgroundTiles?: number;
  orientation?: string;
  state?: string;
  mirrorSide?: boolean;
  rotationScheme?: string;
  animationGroup?: string;
  frame?: number;
}

export interface LoadedAssets {
  catalog: FurnitureAsset[];
  sprites: Map<string, string[][]>; // assetId -> SpriteData
}

// ── Manifest types ──────────────────────────────────────────

interface ManifestAsset {
  type: 'asset';
  id: string;
  file: string;
  width: number;
  height: number;
  footprintW: number;
  footprintH: number;
  orientation?: string;
  state?: string;
  frame?: number;
  mirrorSide?: boolean;
}

interface ManifestGroup {
  type: 'group';
  groupType: 'rotation' | 'state' | 'animation';
  rotationScheme?: string;
  orientation?: string;
  state?: string;
  members: ManifestNode[];
}

type ManifestNode = ManifestAsset | ManifestGroup;

interface FurnitureManifest {
  id: string;
  name: string;
  category: string;
  canPlaceOnWalls: boolean;
  canPlaceOnSurfaces: boolean;
  backgroundTiles: number;
  // If type is 'asset', these fields are present:
  type: 'asset' | 'group';
  file?: string;
  width?: number;
  height?: number;
  footprintW?: number;
  footprintH?: number;
  // If type is 'group':
  groupType?: string;
  rotationScheme?: string;
  members?: ManifestNode[];
}

interface InheritedProps {
  groupId: string;
  name: string;
  category: string;
  canPlaceOnWalls: boolean;
  canPlaceOnSurfaces: boolean;
  backgroundTiles: number;
  orientation?: string;
  state?: string;
  rotationScheme?: string;
  animationGroup?: string;
}

/**
 * Recursively flatten a manifest node into FurnitureAsset[].
 * Inherited properties flow from root to all leaf assets.
 */
function flattenManifest(node: ManifestNode, inherited: InheritedProps): FurnitureAsset[] {
  if (node.type === 'asset') {
    const asset = node as ManifestAsset;
    // Merge orientation: node-level takes priority, then inherited
    const orientation = asset.orientation ?? inherited.orientation;
    const state = asset.state ?? inherited.state;
    return [
      {
        id: asset.id,
        name: inherited.name,
        label: inherited.name,
        category: inherited.category,
        file: asset.file,
        width: asset.width,
        height: asset.height,
        footprintW: asset.footprintW,
        footprintH: asset.footprintH,
        isDesk: inherited.category === 'desks',
        canPlaceOnWalls: inherited.canPlaceOnWalls,
        canPlaceOnSurfaces: inherited.canPlaceOnSurfaces,
        backgroundTiles: inherited.backgroundTiles,
        groupId: inherited.groupId,
        ...(orientation ? { orientation } : {}),
        ...(state ? { state } : {}),
        ...(asset.mirrorSide ? { mirrorSide: true } : {}),
        ...(inherited.rotationScheme ? { rotationScheme: inherited.rotationScheme } : {}),
        ...(inherited.animationGroup ? { animationGroup: inherited.animationGroup } : {}),
        ...(asset.frame !== undefined ? { frame: asset.frame } : {}),
      },
    ];
  }

  // Group node
  const group = node as ManifestGroup;
  const results: FurnitureAsset[] = [];

  for (const member of group.members) {
    // Build inherited props for children
    const childProps: InheritedProps = { ...inherited };

    if (group.groupType === 'rotation') {
      // Rotation groups set groupId and pass rotationScheme
      if (group.rotationScheme) {
        childProps.rotationScheme = group.rotationScheme;
      }
    }

    if (group.groupType === 'state') {
      // State groups propagate orientation from the group level
      if (group.orientation) {
        childProps.orientation = group.orientation;
      }
      // Propagate state from group level if set (for animation groups nested in state)
      if (group.state) {
        childProps.state = group.state;
      }
    }

    if (group.groupType === 'animation') {
      // Animation groups: create animation group ID and propagate state
      // Use the parent's orientation to build a unique animation group name
      const orient = group.orientation ?? inherited.orientation ?? '';
      const state = group.state ?? inherited.state ?? '';
      childProps.animationGroup = `${inherited.groupId}_${orient}_${state}`.toUpperCase();
      if (group.state) {
        childProps.state = group.state;
      }
    }

    // Propagate orientation from group to children (for state groups that have orientation)
    if (group.orientation && !childProps.orientation) {
      childProps.orientation = group.orientation;
    }

    results.push(...flattenManifest(member, childProps));
  }

  return results;
}

/**
 * Load furniture assets from per-folder manifests
 */
export async function loadFurnitureAssets(workspaceRoot: string): Promise<LoadedAssets | null> {
  try {
    console.log(`[AssetLoader] workspaceRoot received: "${workspaceRoot}"`);
    const furnitureDir = path.join(workspaceRoot, 'assets', 'furniture');
    console.log(`[AssetLoader] Scanning furniture directory: ${furnitureDir}`);

    if (!fs.existsSync(furnitureDir)) {
      console.log('ℹ️  No furniture directory found at:', furnitureDir);
      return null;
    }

    const entries = fs.readdirSync(furnitureDir, { withFileTypes: true });
    const dirs = entries.filter((e) => e.isDirectory());

    if (dirs.length === 0) {
      console.log('ℹ️  No furniture subdirectories found');
      return null;
    }

    console.log(`📦 Found ${dirs.length} furniture folders`);

    const catalog: FurnitureAsset[] = [];
    const sprites = new Map<string, string[][]>();

    for (const dir of dirs) {
      const itemDir = path.join(furnitureDir, dir.name);
      const manifestPath = path.join(itemDir, 'manifest.json');

      if (!fs.existsSync(manifestPath)) {
        console.warn(`  ⚠️  No manifest.json in ${dir.name}`);
        continue;
      }

      try {
        const manifestContent = fs.readFileSync(manifestPath, 'utf-8');
        const manifest = JSON.parse(manifestContent) as FurnitureManifest;

        // Build the inherited props from the root manifest
        const inherited: InheritedProps = {
          groupId: manifest.id,
          name: manifest.name,
          category: manifest.category,
          canPlaceOnWalls: manifest.canPlaceOnWalls,
          canPlaceOnSurfaces: manifest.canPlaceOnSurfaces,
          backgroundTiles: manifest.backgroundTiles,
        };

        let assets: FurnitureAsset[];

        if (manifest.type === 'asset') {
          // Single asset manifest (no groups) — file defaults to {id}.png
          assets = [
            {
              id: manifest.id,
              name: manifest.name,
              label: manifest.name,
              category: manifest.category,
              file: manifest.file ?? `${manifest.id}.png`,
              width: manifest.width!,
              height: manifest.height!,
              footprintW: manifest.footprintW!,
              footprintH: manifest.footprintH!,
              isDesk: manifest.category === 'desks',
              canPlaceOnWalls: manifest.canPlaceOnWalls,
              canPlaceOnSurfaces: manifest.canPlaceOnSurfaces,
              backgroundTiles: manifest.backgroundTiles,
              groupId: manifest.id,
            },
          ];
        } else {
          // Group manifest — flatten recursively
          if (manifest.rotationScheme) {
            inherited.rotationScheme = manifest.rotationScheme;
          }
          const rootGroup: ManifestGroup = {
            type: 'group',
            groupType: manifest.groupType as 'rotation' | 'state' | 'animation',
            rotationScheme: manifest.rotationScheme,
            members: manifest.members!,
          };
          assets = flattenManifest(rootGroup, inherited);
        }

        // Load PNGs for each asset
        for (const asset of assets) {
          try {
            const assetPath = path.join(itemDir, asset.file);
            if (!fs.existsSync(assetPath)) {
              console.warn(`  ⚠️  Asset file not found: ${asset.file} in ${dir.name}`);
              continue;
            }

            const pngBuffer = fs.readFileSync(assetPath);
            const spriteData = pngToSpriteData(pngBuffer, asset.width, asset.height);
            sprites.set(asset.id, spriteData);
          } catch (err) {
            console.warn(
              `  ⚠️  Error loading ${asset.id}: ${err instanceof Error ? err.message : err}`,
            );
          }
        }

        catalog.push(...assets);
      } catch (err) {
        console.warn(
          `  ⚠️  Error processing ${dir.name}: ${err instanceof Error ? err.message : err}`,
        );
      }
    }

    console.log(`  ✓ Loaded ${sprites.size} / ${catalog.length} assets`);
    console.log(`[AssetLoader] ✅ Successfully loaded ${sprites.size} furniture sprites`);

    return { catalog, sprites };
  } catch (err) {
    console.error(
      `[AssetLoader] ❌ Error loading furniture assets: ${err instanceof Error ? err.message : err}`,
    );
    return null;
  }
}

/**
 * Convert PNG buffer to SpriteData (2D array of hex color strings)
 *
 * PNG format: RGBA
 * SpriteData format: string[][] where '' = transparent, '#RRGGBB' = opaque, '#RRGGBBAA' = semi-transparent
 */
function rgbaToHex(r: number, g: number, b: number, a: number): string {
  if (a < PNG_ALPHA_THRESHOLD) return '';
  const rgb =
    `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`.toUpperCase();
  if (a >= 255) return rgb;
  return `${rgb}${a.toString(16).padStart(2, '0').toUpperCase()}`;
}

function pngToSpriteData(pngBuffer: Buffer, width: number, height: number): string[][] {
  try {
    // Parse PNG using pngjs
    const png = PNG.sync.read(pngBuffer);

    if (png.width !== width || png.height !== height) {
      console.warn(
        `PNG dimensions mismatch: expected ${width}×${height}, got ${png.width}×${png.height}`,
      );
    }

    const sprite: string[][] = [];
    const data = png.data; // Uint8Array with RGBA values

    for (let y = 0; y < height; y++) {
      const row: string[] = [];
      for (let x = 0; x < width; x++) {
        const pixelIndex = (y * png.width + x) * 4;

        const r = data[pixelIndex];
        const g = data[pixelIndex + 1];
        const b = data[pixelIndex + 2];
        const a = data[pixelIndex + 3];

        row.push(rgbaToHex(r, g, b, a));
      }
      sprite.push(row);
    }

    return sprite;
  } catch (err) {
    console.warn(`Failed to parse PNG: ${err instanceof Error ? err.message : err}`);
    // Return transparent placeholder
    const sprite: string[][] = [];
    for (let y = 0; y < height; y++) {
      sprite.push(new Array(width).fill(''));
    }
    return sprite;
  }
}

// ── Default layout loading ───────────────────────────────────

/**
 * Load the bundled default layout with the highest revision.
 * Scans for assets/default-layout-{N}.json files and picks the one
 * with the largest N. Falls back to assets/default-layout.json for
 * backward compatibility.
 */
export function loadDefaultLayout(assetsRoot: string): Record<string, unknown> | null {
  const assetsDir = path.join(assetsRoot, 'assets');
  try {
    // Scan for versioned default layouts: default-layout-{N}.json
    let bestRevision = 0;
    let bestPath: string | null = null;

    if (fs.existsSync(assetsDir)) {
      for (const file of fs.readdirSync(assetsDir)) {
        const match = /^default-layout-(\d+)\.json$/.exec(file);
        if (match) {
          const rev = parseInt(match[1], 10);
          if (rev > bestRevision) {
            bestRevision = rev;
            bestPath = path.join(assetsDir, file);
          }
        }
      }
    }

    // Fall back to unversioned default-layout.json
    if (!bestPath) {
      const fallback = path.join(assetsDir, 'default-layout.json');
      if (fs.existsSync(fallback)) {
        bestPath = fallback;
      }
    }

    if (!bestPath) {
      console.log('[AssetLoader] No default layout found in:', assetsDir);
      return null;
    }

    const content = fs.readFileSync(bestPath, 'utf-8');
    const layout = JSON.parse(content) as Record<string, unknown>;
    // Ensure layoutRevision matches the file's revision number
    if (bestRevision > 0 && !layout[LAYOUT_REVISION_KEY]) {
      layout[LAYOUT_REVISION_KEY] = bestRevision;
    }
    console.log(
      `[AssetLoader] Loaded default layout (${layout.cols}×${layout.rows}, revision ${layout[LAYOUT_REVISION_KEY] ?? 0}) from ${path.basename(bestPath)}`,
    );
    return layout;
  } catch (err) {
    console.error(
      `[AssetLoader] Error loading default layout: ${err instanceof Error ? err.message : err}`,
    );
    return null;
  }
}

// ── Wall tile loading ────────────────────────────────────────

export interface LoadedWallTiles {
  /** Array of wall sets, each containing 16 sprites indexed by bitmask (N=1,E=2,S=4,W=8) */
  sets: string[][][][];
}

/**
 * Parse a single wall PNG (64×128, 4×4 grid of 16×32 pieces) into 16 bitmask sprites.
 * Piece at bitmask M: col = M % 4, row = floor(M / 4).
 */
function parseWallPng(pngBuffer: Buffer): string[][][] {
  const png = PNG.sync.read(pngBuffer);
  const sprites: string[][][] = [];
  for (let mask = 0; mask < WALL_BITMASK_COUNT; mask++) {
    const ox = (mask % WALL_GRID_COLS) * WALL_PIECE_WIDTH;
    const oy = Math.floor(mask / WALL_GRID_COLS) * WALL_PIECE_HEIGHT;
    const sprite: string[][] = [];
    for (let r = 0; r < WALL_PIECE_HEIGHT; r++) {
      const row: string[] = [];
      for (let c = 0; c < WALL_PIECE_WIDTH; c++) {
        const idx = ((oy + r) * png.width + (ox + c)) * 4;
        const rv = png.data[idx];
        const gv = png.data[idx + 1];
        const bv = png.data[idx + 2];
        const av = png.data[idx + 3];
        row.push(rgbaToHex(rv, gv, bv, av));
      }
      sprite.push(row);
    }
    sprites.push(sprite);
  }
  return sprites;
}

/**
 * Load wall tile sets from assets/walls/ folder.
 * Each file is named wall_N.png (e.g. wall_0.png, wall_1.png, ...).
 * Files are loaded in numeric order; each PNG is a 64×128 grid of 16 bitmask pieces.
 */
export async function loadWallTiles(assetsRoot: string): Promise<LoadedWallTiles | null> {
  try {
    const wallsDir = path.join(assetsRoot, 'assets', 'walls');
    if (!fs.existsSync(wallsDir)) {
      console.log('[AssetLoader] No walls/ directory found at:', wallsDir);
      return null;
    }

    console.log('[AssetLoader] Loading wall tiles from:', wallsDir);

    // Find all wall_N.png files and sort by index
    const entries = fs.readdirSync(wallsDir);
    const wallFiles: { index: number; filename: string }[] = [];
    for (const entry of entries) {
      const match = /^wall_(\d+)\.png$/i.exec(entry);
      if (match) {
        wallFiles.push({ index: parseInt(match[1], 10), filename: entry });
      }
    }

    if (wallFiles.length === 0) {
      console.log('[AssetLoader] No wall_N.png files found in walls/');
      return null;
    }

    wallFiles.sort((a, b) => a.index - b.index);

    const sets: string[][][][] = [];
    for (const { filename } of wallFiles) {
      const filePath = path.join(wallsDir, filename);
      const pngBuffer = fs.readFileSync(filePath);
      const sprites = parseWallPng(pngBuffer);
      sets.push(sprites);
    }

    console.log(
      `[AssetLoader] ✅ Loaded ${sets.length} wall tile set(s) (${sets.length * WALL_BITMASK_COUNT} pieces total)`,
    );
    return { sets };
  } catch (err) {
    console.error(
      `[AssetLoader] ❌ Error loading wall tiles: ${err instanceof Error ? err.message : err}`,
    );
    return null;
  }
}

/**
 * Send wall tiles to webview
 */
export function sendWallTilesToWebview(webview: vscode.Webview, wallTiles: LoadedWallTiles): void {
  webview.postMessage({
    type: 'wallTilesLoaded',
    sets: wallTiles.sets,
  });
  console.log(`📤 Sent ${wallTiles.sets.length} wall tile set(s) to webview`);
}

export interface LoadedFloorTiles {
  sprites: string[][][]; // N sprites (one per floor_N.png), each 16x16 SpriteData
}

/**
 * Load floor tile patterns from assets/floors/ folder.
 * Each file is named floor_N.png (e.g. floor_0.png, floor_1.png, ...).
 * Files are loaded in numeric order; each PNG is a 16×16 grayscale tile.
 */
export async function loadFloorTiles(assetsRoot: string): Promise<LoadedFloorTiles | null> {
  try {
    const floorsDir = path.join(assetsRoot, 'assets', 'floors');
    if (!fs.existsSync(floorsDir)) {
      console.log('[AssetLoader] No floors/ directory found at:', floorsDir);
      return null;
    }

    console.log('[AssetLoader] Loading floor tiles from:', floorsDir);

    // Find all floor_N.png files and sort by index
    const entries = fs.readdirSync(floorsDir);
    const floorFiles: { index: number; filename: string }[] = [];
    for (const entry of entries) {
      const match = /^floor_(\d+)\.png$/i.exec(entry);
      if (match) {
        floorFiles.push({ index: parseInt(match[1], 10), filename: entry });
      }
    }

    if (floorFiles.length === 0) {
      console.log('[AssetLoader] No floor_N.png files found in floors/');
      return null;
    }

    floorFiles.sort((a, b) => a.index - b.index);

    const sprites: string[][][] = [];
    for (const { filename } of floorFiles) {
      const filePath = path.join(floorsDir, filename);
      const pngBuffer = fs.readFileSync(filePath);
      const sprite = pngToSpriteData(pngBuffer, FLOOR_TILE_SIZE, FLOOR_TILE_SIZE);
      sprites.push(sprite);
    }

    console.log(`[AssetLoader] ✅ Loaded ${sprites.length} floor tile patterns from floors/`);
    return { sprites };
  } catch (err) {
    console.error(
      `[AssetLoader] ❌ Error loading floor tiles: ${err instanceof Error ? err.message : err}`,
    );
    return null;
  }
}

/**
 * Send floor tiles to webview
 */
export function sendFloorTilesToWebview(
  webview: vscode.Webview,
  floorTiles: LoadedFloorTiles,
): void {
  webview.postMessage({
    type: 'floorTilesLoaded',
    sprites: floorTiles.sprites,
  });
  console.log(`📤 Sent ${floorTiles.sprites.length} floor tile patterns to webview`);
}

// ── Character sprite loading ────────────────────────────────

export interface CharacterDirectionSprites {
  down: string[][][];
  up: string[][][];
  right: string[][][];
}

export interface LoadedCharacterSprites {
  /** 6 pre-colored characters, each with 9 frames per direction */
  characters: CharacterDirectionSprites[];
}

/**
 * Load pre-colored character sprites from assets/characters/ (6 PNGs, each 112×96).
 * Each PNG has 3 direction rows (down, up, right) × 7 frames (16×32 each).
 */
export async function loadCharacterSprites(
  assetsRoot: string,
): Promise<LoadedCharacterSprites | null> {
  try {
    const charDir = path.join(assetsRoot, 'assets', 'characters');
    const characters: CharacterDirectionSprites[] = [];

    for (let ci = 0; ci < CHAR_COUNT; ci++) {
      const filePath = path.join(charDir, `char_${ci}.png`);
      if (!fs.existsSync(filePath)) {
        console.log(`[AssetLoader] No character sprite found at: ${filePath}`);
        return null;
      }

      const pngBuffer = fs.readFileSync(filePath);
      const png = PNG.sync.read(pngBuffer);

      const directions = CHARACTER_DIRECTIONS;
      const charData: CharacterDirectionSprites = { down: [], up: [], right: [] };

      for (let dirIdx = 0; dirIdx < directions.length; dirIdx++) {
        const dir = directions[dirIdx];
        const rowOffsetY = dirIdx * CHAR_FRAME_H;
        const frames: string[][][] = [];

        for (let f = 0; f < CHAR_FRAMES_PER_ROW; f++) {
          const sprite: string[][] = [];
          const frameOffsetX = f * CHAR_FRAME_W;
          for (let y = 0; y < CHAR_FRAME_H; y++) {
            const row: string[] = [];
            for (let x = 0; x < CHAR_FRAME_W; x++) {
              const idx = ((rowOffsetY + y) * png.width + (frameOffsetX + x)) * 4;
              const r = png.data[idx];
              const g = png.data[idx + 1];
              const b = png.data[idx + 2];
              const a = png.data[idx + 3];
              row.push(rgbaToHex(r, g, b, a));
            }
            sprite.push(row);
          }
          frames.push(sprite);
        }
        charData[dir] = frames;
      }
      characters.push(charData);
    }

    console.log(
      `[AssetLoader] ✅ Loaded ${characters.length} character sprites (${CHAR_FRAMES_PER_ROW} frames × 3 directions each)`,
    );
    return { characters };
  } catch (err) {
    console.error(
      `[AssetLoader] ❌ Error loading character sprites: ${err instanceof Error ? err.message : err}`,
    );
    return null;
  }
}

/**
 * Send character sprites to webview
 */
export function sendCharacterSpritesToWebview(
  webview: vscode.Webview,
  charSprites: LoadedCharacterSprites,
): void {
  webview.postMessage({
    type: 'characterSpritesLoaded',
    characters: charSprites.characters,
  });
  console.log(`📤 Sent ${charSprites.characters.length} character sprites to webview`);
}

/**
 * Send loaded assets to webview
 */
export function sendAssetsToWebview(webview: vscode.Webview, assets: LoadedAssets): void {
  if (!assets) {
    console.log('[AssetLoader] ⚠️  No assets to send');
    return;
  }

  console.log('[AssetLoader] Converting sprites Map to object...');
  // Convert sprites Map to plain object for JSON serialization
  const spritesObj: Record<string, string[][]> = {};
  for (const [id, spriteData] of assets.sprites) {
    spritesObj[id] = spriteData;
  }

  console.log(
    `[AssetLoader] Posting furnitureAssetsLoaded message with ${assets.catalog.length} assets`,
  );
  webview.postMessage({
    type: 'furnitureAssetsLoaded',
    catalog: assets.catalog,
    sprites: spritesObj,
  });

  console.log(`📤 Sent ${assets.catalog.length} furniture assets to webview`);
}

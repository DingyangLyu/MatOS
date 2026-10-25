// Per-asset-type visual identity for the MatOS Assets workbench.
//
// Single source of truth for the icon + accent color every surface uses when
// it shows an asset of a given registry type (catalog cards, detail hero,
// structured editor panels, home gallery). Hues intentionally match the
// galaxy view's ASSET_TYPE_HUES (asset-graph-model.ts) so the same asset
// reads as the same color family across the grid, the galaxy, and the
// editors. Accents are fixed mid-tone values (like the workflow canvas node
// accents) and get theme-adaptive tints/borders via `color-mix` with theme
// tokens in CSS.

import type { IconName } from './Icon';

export interface AssetTypeMeta {
  /** Registry type id (`asset.type`). */
  type: string;
  icon: IconName;
  /** Fixed mid-tone accent that works on both light and dark panels. */
  accent: string;
  /** Galaxy-consistent hue (asset-graph-model.ts ASSET_TYPE_HUES). */
  hue: number;
}

const META: Record<string, AssetTypeMeta> = {
  knowledge: { type: 'knowledge', icon: 'book-open', accent: 'hsl(210 62% 50%)', hue: 210 },
  data: { type: 'data', icon: 'flask', accent: 'hsl(185 55% 40%)', hue: 185 },
  tool: { type: 'tool', icon: 'hammer', accent: 'hsl(38 70% 42%)', hue: 38 },
  mcp: { type: 'mcp', icon: 'plug', accent: 'hsl(24 70% 50%)', hue: 24 },
  skill: { type: 'skill', icon: 'sparkles', accent: 'hsl(268 55% 56%)', hue: 268 },
  role: { type: 'role', icon: 'bot', accent: 'hsl(145 45% 40%)', hue: 145 },
  workflow: { type: 'workflow', icon: 'fork', accent: 'hsl(325 55% 50%)', hue: 325 },
  benchmark: { type: 'benchmark', icon: 'gauge', accent: 'hsl(55 60% 40%)', hue: 55 },
  'benchmark-suite': { type: 'benchmark-suite', icon: 'gauge', accent: 'hsl(62 55% 38%)', hue: 62 },
  evaluation: { type: 'evaluation', icon: 'check', accent: 'hsl(95 45% 40%)', hue: 95 },
  runtime: { type: 'runtime', icon: 'terminal', accent: 'hsl(232 50% 56%)', hue: 232 },
};

const FALLBACK: AssetTypeMeta = { type: 'other', icon: 'file', accent: 'hsl(220 10% 55%)', hue: 220 };

export function assetTypeMeta(type: string): AssetTypeMeta {
  return META[type] ?? FALLBACK;
}

/**
 * Inline style payload that scopes the per-type accent onto a subtree.
 * CSS consumes `--asset-accent` via `color-mix` so tints/borders adapt to
 * the active theme automatically.
 */
export function assetAccentStyle(type: string): Record<string, string> {
  return { ['--asset-accent']: assetTypeMeta(type).accent };
}

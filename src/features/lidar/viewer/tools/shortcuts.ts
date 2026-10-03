// ============================================
// LiDAR viewer tools — keyboard shortcuts
// ============================================

import type { ToolId } from './types';

/** Key (lower case) that starts each tool; also shown in the menu tooltips and the help line. */
export const TOOL_SHORTCUTS: Readonly<Partial<Record<ToolId, string>>> = {
  distance: 'm',
  height: 'h',
  area: 's',
  profile: 'p',
  fallLine: 'f',
  avalanche: 'a',
  viewshed: 'v',
};

const TOOL_BY_KEY = new Map<string, ToolId>(
  (Object.entries(TOOL_SHORTCUTS) as Array<[ToolId, string]>).map(([tool, key]) => [key, tool]),
);

export function toolForKey(key: string): ToolId | null {
  return TOOL_BY_KEY.get(key.toLowerCase()) ?? null;
}

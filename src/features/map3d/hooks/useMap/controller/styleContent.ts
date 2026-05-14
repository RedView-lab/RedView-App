type StyleLike = {
  layers?: unknown[];
  sources?: Record<string, unknown>;
  imports?: Array<{ data?: unknown }>;
} | null | undefined;

export interface StyleContentStats {
  layerCount: number;
  sourceCount: number;
  importCount: number;
  hasImportContent: boolean;
  hasContent: boolean;
}

export function getStyleContentStats(style: StyleLike): StyleContentStats {
  const layerCount = style?.layers?.length ?? 0;
  const sourceCount = Object.keys(style?.sources ?? {}).length;
  const imports = style?.imports;
  const hasImportContent = Array.isArray(imports)
    && imports.some((entry) => entry && entry.data != null);

  return {
    layerCount,
    sourceCount,
    importCount: Array.isArray(imports) ? imports.length : 0,
    hasImportContent,
    hasContent: layerCount > 0 || sourceCount > 0 || hasImportContent,
  };
}

export function styleHasUsableContent(style: StyleLike): boolean {
  return getStyleContentStats(style).hasContent;
}

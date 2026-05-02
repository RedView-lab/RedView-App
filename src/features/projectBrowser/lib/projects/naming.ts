export function buildCopiedName(baseName: string, siblingNames: string[]): string {
  const trimmedBaseName = baseName.trim() || 'Sans nom';
  const normalizedSiblingNames = new Set(siblingNames.map((name) => name.trim().toLowerCase()));
  const baseCopyName = `${trimmedBaseName} copie`;

  if (!normalizedSiblingNames.has(baseCopyName.toLowerCase())) {
    return baseCopyName;
  }

  let suffix = 2;
  while (normalizedSiblingNames.has(`${baseCopyName} ${suffix}`.toLowerCase())) {
    suffix += 1;
  }

  return `${baseCopyName} ${suffix}`;
}
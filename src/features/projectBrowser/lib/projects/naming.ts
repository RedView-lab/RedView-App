import { translateAppText } from '@/shared/i18n';

export function buildCopiedName(baseName: string, siblingNames: string[]): string {
  const trimmedBaseName = baseName.trim() || translateAppText('Sans nom');
  const normalizedSiblingNames = new Set(siblingNames.map((name) => name.trim().toLowerCase()));
  const baseCopyName = `${trimmedBaseName} ${translateAppText('copie')}`;

  if (!normalizedSiblingNames.has(baseCopyName.toLowerCase())) {
    return baseCopyName;
  }

  let suffix = 2;
  while (normalizedSiblingNames.has(`${baseCopyName} ${suffix}`.toLowerCase())) {
    suffix += 1;
  }

  return `${baseCopyName} ${suffix}`;
}
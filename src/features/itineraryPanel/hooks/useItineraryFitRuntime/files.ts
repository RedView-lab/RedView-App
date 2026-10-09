import { buildFitUploadsSignature } from '../../lib/schedule';

/** Identité d'un .fit, commune aux `File` en mémoire et aux uploads persistés. */
export function fitFileKey(file: { name: string; lastModified: number; size: number }): string {
  return `${file.name}:${file.lastModified}:${file.size}`;
}

function mergeFitFiles(existingFiles: readonly File[], incomingFiles: readonly File[]): File[] {
  const merged: File[] = [...existingFiles];
  const seen = new Set(existingFiles.map(fitFileKey));

  for (const file of incomingFiles) {
    const key = fitFileKey(file);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(file);
  }

  return merged;
}

export function fitFilesEqual(left: readonly File[], right: readonly File[]): boolean {
  return (
    left.length === right.length &&
    left.every((file, index) => {
      const nextFile = right[index];
      return (
        file.name === nextFile?.name &&
        file.lastModified === nextFile.lastModified &&
        file.size === nextFile.size
      );
    })
  );
}

export function buildLocalFitUploadSignature(files: readonly File[]): string {
  return buildFitUploadsSignature(
    files.map((file) => ({
      name: file.name,
      lastModified: file.lastModified,
      size: file.size,
    })),
  );
}
/**
 * Fichiers d'une sélection à ajouter à un itinéraire : les `.fit` lisibles,
 * dédoublonnés, dans la limite de `maxFiles`. Ceux qui ne passent pas
 * (`problems[i]` non nul, extension autre que .fit) ou dépassent la limite
 * sont rendus pour être nommés à l'utilisateur — jamais écartés en silence.
 */
export function planFitSelection<P>(
  currentFiles: readonly File[],
  selected: readonly File[],
  problems: readonly (P | null)[],
  maxFiles: number,
): { nextFitFiles: File[]; added: number; rejected: Array<{ file: File; reason: P }>; overLimit: File[] } {
  const incoming = selected.filter((_, index) => problems[index] == null);
  const rejected = selected.flatMap((file, index) => {
    const reason = problems[index];
    return reason != null ? [{ file, reason }] : [];
  });
  const merged = mergeFitFiles(currentFiles, incoming);
  const nextFitFiles = merged.slice(0, Math.max(maxFiles, currentFiles.length));
  return {
    nextFitFiles,
    added: nextFitFiles.length - currentFiles.length,
    rejected,
    overLimit: merged.slice(nextFitFiles.length),
  };
}

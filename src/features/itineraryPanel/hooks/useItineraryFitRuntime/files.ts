import { buildFitUploadsSignature } from '../../lib/schedule';

/** Identité d'un .fit, commune aux `File` en mémoire et aux uploads persistés. */
export function fitFileKey(file: { name: string; lastModified: number; size: number }): string {
  return `${file.name}:${file.lastModified}:${file.size}`;
}

export function mergeFitFiles(existingFiles: readonly File[], incomingFiles: readonly File[]): File[] {
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
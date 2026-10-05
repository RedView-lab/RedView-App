import { useEffect, useRef, useState } from 'react';

function carriesFiles(event: DragEvent): boolean {
  return Array.from(event.dataTransfer?.types ?? []).includes('Files');
}

/**
 * Fichiers déposés n'importe où dans la fenêtre (import de projets `.redview`).
 * Seuls les glisser-déposer de fichiers du système sont pris : le
 * déplacement des cartes projet / dossier (glisser-déposer interne, sans
 * `Files`) n'est pas touché. Les écouteurs restent posés tant que le panneau
 * est monté : un fichier lâché pendant un import est refusé au lieu d'être
 * ouvert par le navigateur (qui quitterait l'application). Renvoie vrai
 * pendant le survol, pour afficher la zone de dépôt.
 */
export function useFileDropImport({
  accepting,
  onFiles,
}: {
  /** Faux pendant un import : dépôt refusé. */
  accepting: boolean;
  onFiles: (files: File[]) => void;
}): boolean {
  const [hovering, setHovering] = useState(false);
  const depthRef = useRef(0);
  const acceptingRef = useRef(accepting);
  const onFilesRef = useRef(onFiles);

  useEffect(() => {
    acceptingRef.current = accepting;
    onFilesRef.current = onFiles;
  }, [accepting, onFiles]);

  useEffect(() => {
    const handleDragEnter = (event: DragEvent) => {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      depthRef.current += 1;
      setHovering(true);
    };
    const handleDragOver = (event: DragEvent) => {
      if (!carriesFiles(event)) return;
      // Sans preventDefault, le navigateur ouvrirait le fichier déposé.
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = acceptingRef.current ? 'copy' : 'none';
    };
    const handleDragLeave = (event: DragEvent) => {
      if (!carriesFiles(event)) return;
      depthRef.current = Math.max(0, depthRef.current - 1);
      if (depthRef.current === 0) setHovering(false);
    };
    const handleDrop = (event: DragEvent) => {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      depthRef.current = 0;
      setHovering(false);
      const files = Array.from(event.dataTransfer?.files ?? []);
      if (acceptingRef.current && files.length > 0) onFilesRef.current(files);
    };

    window.addEventListener('dragenter', handleDragEnter);
    window.addEventListener('dragover', handleDragOver);
    window.addEventListener('dragleave', handleDragLeave);
    window.addEventListener('drop', handleDrop);
    return () => {
      window.removeEventListener('dragenter', handleDragEnter);
      window.removeEventListener('dragover', handleDragOver);
      window.removeEventListener('dragleave', handleDragLeave);
      window.removeEventListener('drop', handleDrop);
      depthRef.current = 0;
    };
  }, []);

  return hovering && accepting;
}

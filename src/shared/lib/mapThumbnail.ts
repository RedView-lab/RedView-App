/**
 * Capture un instantané JPEG réduit du canvas Mapbox en direct.
 *
 * Utilisé par le gestionnaire de projets pour afficher une miniature par
 * projet. Capture le canvas WebGL de façon synchrone sur `render` via
 * `map.triggerRepaint()`, proprement, sans exiger
 * `preserveDrawingBuffer: true`.
 *
 * Le pipeline de capture :
 *   canvas de la carte (pleine résolution en pixels physiques)
 *     → canvas hors écran à `targetWidth` (object-fit: cover)
 *     → blob JPEG
 *
 * Renvoie null si la carte n'est pas prête ou si la capture a échoué pour une
 * raison quelconque (relecture bloquée, canvas souillé, mémoire épuisée…). Les
 * appelants doivent traiter null comme « pas d'envoi de miniature, on garde la
 * précédente ». Une image d'une seule couleur (carte pas encore dessinée,
 * style absent, tampon WebGL déjà vidé quand le repli le relit) n'est pas une
 * miniature : elle remplaçait la bonne pour tous les éditeurs à chaque projet
 * fermé trop tôt.
 */
import type { Map as MapboxMap } from 'mapbox-gl';

/** Écart par canal sous lequel deux pixels sont « la même couleur » (bruit d'encodage). */
const UNIFORM_TOLERANCE = 6;

/** Vrai si tous les pixels (RGBA) échantillonnés ont la couleur du premier. */
export function isUniformImage(data: ArrayLike<number>, step = 7): boolean {
  if (data.length < 4) return true;
  const [r, g, b] = [data[0]!, data[1]!, data[2]!];
  for (let i = 4 * step; i < data.length; i += 4 * step) {
    if (
      Math.abs(data[i]! - r) > UNIFORM_TOLERANCE
      || Math.abs(data[i + 1]! - g) > UNIFORM_TOLERANCE
      || Math.abs(data[i + 2]! - b) > UNIFORM_TOLERANCE
    ) {
      return false;
    }
  }
  return true;
}

export async function captureMapThumbnail(
  map: MapboxMap | null,
  targetWidth = 320,
  aspectRatio = 16 / 9,
): Promise<Blob | null> {
  if (!map) return null;

  const renderSnapshot = (src: HTMLCanvasElement): Promise<Blob | null> => {
    try {
      const targetHeight = Math.round(targetWidth / aspectRatio);
      const off = document.createElement('canvas');
      off.width = targetWidth;
      off.height = targetHeight;
      const ctx = off.getContext('2d');
      if (!ctx) return Promise.resolve(null);
      ctx.fillStyle = '#141414';
      ctx.fillRect(0, 0, targetWidth, targetHeight);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';

      // Cover : mise à l'échelle pour remplir, l'excédent est rogné.
      const srcAspect = src.width / src.height;
      let sx = 0;
      let sy = 0;
      let sw = src.width;
      let sh = src.height;
      if (srcAspect > aspectRatio) {
        sw = Math.round(src.height * aspectRatio);
        sx = Math.round((src.width - sw) / 2);
      } else {
        sh = Math.round(src.width / aspectRatio);
        sy = Math.round((src.height - sh) / 2);
      }
      ctx.drawImage(src, sx, sy, sw, sh, 0, 0, targetWidth, targetHeight);
      if (isUniformImage(ctx.getImageData(0, 0, targetWidth, targetHeight).data)) return Promise.resolve(null);

      return new Promise<Blob | null>((resolve) => {
        // Encodage WebP léger et ultra-net (qualité 0.65), fallback JPEG 0.68
        off.toBlob((blob) => {
          if (blob && blob.size > 0) {
            resolve(blob);
          } else {
            off.toBlob((jpegBlob) => resolve(jpegBlob), 'image/jpeg', 0.68);
          }
        }, 'image/webp', 0.65);
      });
    } catch {
      return Promise.resolve(null);
    }
  };

  return new Promise<Blob | null>((resolve) => {
    let settled = false;
    const finish = (blob: Blob | null) => {
      if (settled) return;
      settled = true;
      resolve(blob);
    };

    // Prend le canvas tout de suite dans le callback de rendu, avant que le tampon soit vidé
    const onRender = () => {
      try {
        const src = map.getCanvas();
        if (!src || src.width === 0 || src.height === 0) {
          finish(null);
          return;
        }
        void renderSnapshot(src).then(finish);
      } catch {
        finish(null);
      }
    };

    map.once('render', onRender);
    map.triggerRepaint();

    // Repli : tentative directe ou délai, au cas où la carte est déjà peinte ou démontée
    setTimeout(() => {
      if (settled) return;
      const src = map.getCanvas?.();
      if (src && src.width > 0 && src.height > 0) {
        void renderSnapshot(src).then(finish);
      } else {
        finish(null);
      }
    }, 600);
  });
}

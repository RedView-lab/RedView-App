/**
 * RedView Test-Bench : moteur LiDAR WebGPU — précision, LOD, streaming (CPU, sans GPU)
 *
 * Critères durs (code de sortie ≠ 0 en cas d'échec) :
 * 1. Précision des positions décodées (decodeCopcChunks réel, laz-perf simulé)
 *    sur des coordonnées Lambert-93 : < 1 mm (l'ancien stockage absolu Float32
 *    quantifiait le nord à 0,5 m).
 * 2. Taille écran d'un nœud indépendante de l'inclinaison caméra (l'ancienne
 *    focale lue dans viewProj[5] s'effondrait en vue de dessus).
 * 3. Octree LOD additive : chaque point stocké une seule fois, quantification
 *    u16 sous le centimètre.
 * 4. Streaming 9 tuiles : densité complète près de la caméra, budget de points
 *    respecté, mémoire GPU bornée (l'ancien chargement décimait la scène
 *    entière avant l'octree).
 * 5. Chargements : depuis une scène vierge et une caméra fixe, chaque bloc lu
 *    est affiché (la cible compte les nœuds en attente), sélection stable.
 * 6. Couverture : en vue rasante avec un budget minuscule, chaque tuile
 *    visible garde au moins sa racine.
 * 7. Taille de point adaptative : les masques d'octants envoyés au GPU
 *    correspondent exactement aux enfants affichés.
 * 8. Bornes serrées des nœuds : chaque point tient dans son nœud et dans tous
 *    ses ancêtres une fois les bornes resserrées sur les points chargés.
 * 9. Cadence réelle : FrameClock retrouve la période d'écran (60/120/144 Hz)
 *    malgré des vsync ratées, et ne prend jamais un GPU à 30 fps pour un
 *    écran à 30 Hz.
 * 10. Budget de points : sur un GPU dont les frames ratent la vsync au-delà
 *    d'un certain nombre de points, il se stabilise juste en dessous (l'ancien
 *    contrôleur, calé sur 16,6 ms de GPU, restait entre 12,5 et 19 ms : une
 *    vsync sur deux ratée à 60 Hz) ; quand le GPU baisse sa fréquence (temps
 *    de passe stable) et que la cadence tient, il monte au plafond ; une frame
 *    à l'arrêt (pleine résolution) ne le fait jamais baisser.
 * 11. Couleurs filtrées : chaque point d'un nœud qui a des enfants porte la
 *    moyenne de sa maille sur tout le sous-arbre (niveaux grossiers = image
 *    sous-échantillonnée, pas un échantillon isolé de l'ortho).
 * 12. Terrain LOD : un bord cousu vers un voisin plus grossier n'utilise que
 *    les sommets de ce voisin (pas de fissure en T), à chaque niveau.
 * 13. Image au repos : le budget monte vers ~50 ms de GPU par frame fixe,
 *    puis 16 frames décalées sous le pixel sont accumulées ; un mouvement
 *    revient aussitôt au budget du mouvement.
 * Optionnel : LIDAR_TILE=<fichier .copc.laz> mesure le pipeline sur une vraie
 * tuile (décodage laz-perf, construction de l'octree LOD, sélection) et
 * vérifie que la marge des bornes serrées (2 mailles) couvre ses sous-arbres.
 *
 * Usage : npm run bench:lidar-lod   (LIDAR_TILE=... npm run bench:lidar-lod)
 */
import { runBudgetCheck, runFrameClockCheck } from './lidar-lod/frameBudgetCheck.ts';
import { notes, results } from './lidar-lod/harness.ts';
import { runLodTileCheck } from './lidar-lod/lodTileCheck.ts';
import { runPrecisionCheck } from './lidar-lod/precisionCheck.ts';
import { runRealTile } from './lidar-lod/realTileCheck.ts';
import { runRenderQualityCheck } from './lidar-lod/renderQualityCheck.ts';
import { runScreenSizeCheck } from './lidar-lod/screenSizeCheck.ts';
import { runSelectionCheck } from './lidar-lod/selectionCheck.ts';
import { runStreamingCheck } from './lidar-lod/streamingCheck.ts';

runPrecisionCheck();
runScreenSizeCheck();
runLodTileCheck();
await runStreamingCheck();
await runSelectionCheck();
runFrameClockCheck();
runBudgetCheck();
runRenderQualityCheck();
if (process.env.LIDAR_TILE) await runRealTile(process.env.LIDAR_TILE);

console.log('\nLiDAR WebGPU — précision / LOD / streaming\n');
for (const result of results) {
  console.log(`${result.pass ? 'PASS' : 'FAIL'}  ${result.name}`);
  console.log(`      avant : ${result.before}`);
  console.log(`      après : ${result.after}`);
}
if (notes.length) console.log(`\n${notes.join('\n')}`);
const failed = results.filter((result) => !result.pass);
console.log(`\n${results.length - failed.length}/${results.length} critères respectés`);
if (failed.length > 0) process.exit(1);

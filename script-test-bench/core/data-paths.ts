/**
 * Où les bancs trouvent les données réelles non versionnées (GPX des routes de
 * référence, sorties FIT, exports) : un seul dossier, `REDVIEW_BENCH_DATA`,
 * par défaut le dossier Téléchargements de l'utilisateur. Les variables propres
 * à une suite (`PACE_FIT_DIR`, `AUDIT_GPX_DIR`, …) remplacent toujours une
 * entrée isolée.
 */
import os from 'node:os';
import path from 'node:path';

export const BENCH_DATA_DIR = process.env.REDVIEW_BENCH_DATA ?? path.join(os.homedir(), 'Downloads');

/** Chemin d'un fichier du dossier de données du banc. */
export function benchDataFile(...segments: string[]): string {
  return path.join(BENCH_DATA_DIR, ...segments);
}

/** Route de référence GT20 (Grande Traversée du 20e), utilisée par les suites allure, POI et audit. */
export const GT20_GPX = benchDataFile('GT20.gpx');

/** Sorties FIT Chamonix → Paris (vérité terrain du moteur d'allure). */
export const CHAM_PARIS_FIT_DIR = benchDataFile('wetransfer_cham_paris_a_velo_jour_1-fit_2026-09-24_1025');

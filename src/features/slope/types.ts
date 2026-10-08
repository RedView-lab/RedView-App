// ── Définition d'une catégorie de pente ───────────────────────────────

export interface SlopeCategory {
  id: string;
  label: string;
  /** Angle de pente minimal en degrés (inclus) */
  minDeg: number;
  /** Angle de pente maximal en degrés (exclu, Infinity pour la dernière) */
  maxDeg: number;
  /** Couleur d'affichage (hexadécimale) */
  color: string;
  /** Libellé de plage préformaté tel qu'il doit apparaître dans la légende
   *  (p. ex. "0 - 7%", "7% - 12%", "<24%"). Correspond au nœud Figma 1749:57744. */
  displayRange: string;
}

// ── Mode de coloration ────────────────────────────────────────────────

export type SlopeColorMode = 'gradient' | 'step';

// ── État utilisateur persisté ─────────────────────────────────────────

export type SlopeDemProfile = 'default' | 'terrain';

export interface SlopeState {
  enabled: boolean;
  opacity: number;
  colorMode: SlopeColorMode;
  /** @deprecated La résolution est désormais héritée dynamiquement de la carte 3D active */
  resolution?: string;
}

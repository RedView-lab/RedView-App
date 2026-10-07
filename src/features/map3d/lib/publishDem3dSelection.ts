import { setActiveDem3dQuality } from './dem3dQualityBus';
import { resolveDem3dSelection } from './dem3dSelection';
import { setActiveDemProfilePreference } from './demProfileBus';

/**
 * Publie le choix « Qualité 3D » sur les deux bus (qualité, profil DEM), dans
 * l'ordre qui ne charge qu'une vague de tuiles : en sortant du 30 m, le profil
 * d'abord (sans effet tant que le 30 m est actif), puis la qualité HD, qui
 * construit ses tuiles avec lui — dans l'autre ordre, le relief HD partait sur
 * l'ancien profil puis était rechargé (audit d-basemap-quality). Vers le 30 m,
 * la qualité d'abord : le relief HD est détaché, le profil n'a plus d'effet.
 */
export function publishDem3dSelection(value: string | null | undefined): void {
  const next = resolveDem3dSelection(value);
  if (next.quality === 'fast-30m') {
    setActiveDem3dQuality(next.quality);
    setActiveDemProfilePreference(next.profile);
  } else {
    setActiveDemProfilePreference(next.profile);
    setActiveDem3dQuality(next.quality);
  }
}

/**
 * Routing-quality bench — trajets et configurations.
 *
 * Trajets réels dans la couverture des tuiles BRouter du VPS (Europe de
 * l'Ouest : France, Benelux, Suisse, Italie du Nord, Espagne). Les tranches
 * suivent la distance à vol d'oiseau des tronçons (somme départ → via → arrivée).
 * Configurations = presets réels de l'app (`syncTracageOnActivityChange`) +
 * variantes « Paramètres additionnels » telles que l'UI les écrit.
 */
export type Pt = { lat: number; lon: number };

export type Band = '<100' | '100-200' | '200-500' | '>500';

export interface BenchRoute {
  id: string;
  label: string;
  terrain: 'plat' | 'vallonné' | 'montagne' | 'urbain' | 'côtier';
  start: Pt;
  end: Pt;
  via?: Pt[];
}

const P = {
  paris: { lat: 48.8566, lon: 2.3522 },
  parisEiffel: { lat: 48.8584, lon: 2.2945 },
  parisVincennes: { lat: 48.8283, lon: 2.433 },
  fontainebleau: { lat: 48.4047, lon: 2.7016 },
  orleans: { lat: 47.903, lon: 1.9093 },
  rouen: { lat: 49.4432, lon: 1.0999 },
  lyon: { lat: 45.764, lon: 4.8357 },
  lyonFourviere: { lat: 45.7623, lon: 4.8221 },
  miribel: { lat: 45.825, lon: 4.945 },
  grenoble: { lat: 45.1885, lon: 5.7245 },
  chamrousse: { lat: 45.11, lon: 5.878 },
  bourgOisans: { lat: 45.0556, lon: 6.0306 },
  briancon: { lat: 44.8986, lon: 6.6436 },
  valloire: { lat: 45.165, lon: 6.429 },
  galibier: { lat: 45.064, lon: 6.408 },
  annecy: { lat: 45.8992, lon: 6.1294 },
  talloires: { lat: 45.8417, lon: 6.2125 },
  albertville: { lat: 45.6755, lon: 6.3925 },
  chambery: { lat: 45.5646, lon: 5.9178 },
  chamonix: { lat: 45.9237, lon: 6.8694 },
  martigny: { lat: 46.1028, lon: 7.0727 },
  courmayeur: { lat: 45.7969, lon: 6.969 },
  bourgStMaurice: { lat: 45.6186, lon: 6.7697 },
  geneve: { lat: 46.2044, lon: 6.1432 },
  besancon: { lat: 47.2378, lon: 6.0241 },
  dijon: { lat: 47.322, lon: 5.0415 },
  beaune: { lat: 47.026, lon: 4.84 },
  strasbourg: { lat: 48.5734, lon: 7.7521 },
  colmar: { lat: 48.0794, lon: 7.3585 },
  mulhouse: { lat: 47.7508, lon: 7.3359 },
  nancy: { lat: 48.6921, lon: 6.1844 },
  metz: { lat: 49.1193, lon: 6.1757 },
  reims: { lat: 49.2583, lon: 4.0317 },
  lille: { lat: 50.6292, lon: 3.0573 },
  amiens: { lat: 49.8941, lon: 2.2958 },
  calais: { lat: 50.9513, lon: 1.8587 },
  caen: { lat: 49.1829, lon: -0.3707 },
  leMans: { lat: 48.0061, lon: 0.1996 },
  rennes: { lat: 48.1173, lon: -1.6778 },
  stMalo: { lat: 48.6493, lon: -2.0257 },
  brest: { lat: 48.3904, lon: -4.4861 },
  lorient: { lat: 47.7483, lon: -3.37 },
  nantes: { lat: 47.2184, lon: -1.5536 },
  stNazaire: { lat: 47.2735, lon: -2.2138 },
  tours: { lat: 47.3941, lon: 0.6848 },
  poitiers: { lat: 46.5802, lon: 0.3404 },
  limoges: { lat: 45.8336, lon: 1.2611 },
  clermont: { lat: 45.7772, lon: 3.087 },
  montDore: { lat: 45.5753, lon: 2.8092 },
  lePuy: { lat: 45.0434, lon: 3.8858 },
  stEtienne: { lat: 45.4397, lon: 4.3872 },
  bordeaux: { lat: 44.8378, lon: -0.5792 },
  arcachon: { lat: 44.6586, lon: -1.1689 },
  bergerac: { lat: 44.8533, lon: 0.4833 },
  toulouse: { lat: 43.6047, lon: 1.4442 },
  albi: { lat: 43.9289, lon: 2.1464 },
  carcassonne: { lat: 43.213, lon: 2.3491 },
  montpellier: { lat: 43.6108, lon: 3.8767 },
  millau: { lat: 44.0986, lon: 3.0783 },
  perpignan: { lat: 42.6887, lon: 2.8948 },
  foix: { lat: 42.9653, lon: 1.6053 },
  pau: { lat: 43.2951, lon: -0.3708 },
  lourdes: { lat: 43.0947, lon: -0.0458 },
  bayonne: { lat: 43.4929, lon: -1.4748 },
  biarritz: { lat: 43.4832, lon: -1.5586 },
  pamplona: { lat: 42.8125, lon: -1.6458 },
  marseille: { lat: 43.2965, lon: 5.3698 },
  aix: { lat: 43.5297, lon: 5.4474 },
  cassis: { lat: 43.214, lon: 5.5396 },
  frejus: { lat: 43.433, lon: 6.737 },
  nice: { lat: 43.7102, lon: 7.262 },
  digne: { lat: 44.0925, lon: 6.2356 },
  avignon: { lat: 43.9493, lon: 4.8055 },
  gap: { lat: 44.5594, lon: 6.0786 },
  barcelona: { lat: 41.3874, lon: 2.1686 },
} satisfies Record<string, Pt>;

export const ROUTES: BenchRoute[] = [
  // ── < 100 km ────────────────────────────────────────────────────────
  { id: 'valloire-galibier', label: 'Valloire → Galibier', terrain: 'montagne', start: P.valloire, end: P.galibier },
  { id: 'grenoble-oisans', label: "Grenoble → Bourg-d'Oisans", terrain: 'montagne', start: P.grenoble, end: P.bourgOisans },
  { id: 'annecy-albertville', label: 'Annecy → Albertville', terrain: 'montagne', start: P.annecy, end: P.albertville },
  { id: 'paris-fontainebleau', label: 'Paris → Fontainebleau', terrain: 'urbain', start: P.paris, end: P.fontainebleau },
  { id: 'strasbourg-colmar', label: 'Strasbourg → Colmar', terrain: 'plat', start: P.strasbourg, end: P.colmar },
  { id: 'bordeaux-arcachon', label: 'Bordeaux → Arcachon', terrain: 'plat', start: P.bordeaux, end: P.arcachon },
  { id: 'pau-lourdes', label: 'Pau → Lourdes', terrain: 'vallonné', start: P.pau, end: P.lourdes },
  { id: 'rennes-stmalo', label: 'Rennes → Saint-Malo', terrain: 'vallonné', start: P.rennes, end: P.stMalo },
  { id: 'dijon-beaune', label: 'Dijon → Beaune', terrain: 'vallonné', start: P.dijon, end: P.beaune },
  { id: 'chamonix-martigny', label: 'Chamonix → Martigny (CH)', terrain: 'montagne', start: P.chamonix, end: P.martigny },
  { id: 'marseille-aix', label: 'Marseille → Aix-en-Provence', terrain: 'urbain', start: P.marseille, end: P.aix },
  { id: 'clermont-montdore', label: 'Clermont-Ferrand → Le Mont-Dore', terrain: 'montagne', start: P.clermont, end: P.montDore },
  { id: 'toulouse-albi', label: 'Toulouse → Albi', terrain: 'vallonné', start: P.toulouse, end: P.albi },
  { id: 'nantes-stnazaire', label: 'Nantes → Saint-Nazaire', terrain: 'côtier', start: P.nantes, end: P.stNazaire },
  // Courts (course à pied)
  { id: 'paris-eiffel-vincennes', label: 'Paris Tour Eiffel → Vincennes', terrain: 'urbain', start: P.parisEiffel, end: P.parisVincennes },
  { id: 'lyon-fourviere-miribel', label: 'Lyon Fourvière → Miribel', terrain: 'urbain', start: P.lyonFourviere, end: P.miribel },
  { id: 'annecy-talloires', label: 'Annecy → Talloires', terrain: 'montagne', start: P.annecy, end: P.talloires },
  { id: 'marseille-cassis', label: 'Marseille → Cassis', terrain: 'côtier', start: P.marseille, end: P.cassis },
  { id: 'grenoble-chamrousse', label: 'Grenoble → Chamrousse', terrain: 'montagne', start: P.grenoble, end: P.chamrousse },
  { id: 'chamonix-courmayeur', label: 'Chamonix → Courmayeur (IT)', terrain: 'montagne', start: P.chamonix, end: P.courmayeur },
  { id: 'chamonix-bourgstmaurice', label: 'Chamonix → Bourg-Saint-Maurice', terrain: 'montagne', start: P.chamonix, end: P.bourgStMaurice },

  // ── 100–200 km ─────────────────────────────────────────────────────
  { id: 'lyon-grenoble', label: 'Lyon → Grenoble', terrain: 'vallonné', start: P.lyon, end: P.grenoble },
  { id: 'paris-orleans', label: 'Paris → Orléans', terrain: 'plat', start: P.paris, end: P.orleans },
  { id: 'paris-rouen', label: 'Paris → Rouen', terrain: 'vallonné', start: P.paris, end: P.rouen },
  { id: 'grenoble-briancon', label: 'Grenoble → Briançon', terrain: 'montagne', start: P.grenoble, end: P.briancon },
  { id: 'nice-digne', label: 'Nice → Digne-les-Bains', terrain: 'montagne', start: P.nice, end: P.digne },
  { id: 'clermont-lepuy', label: 'Clermont-Ferrand → Le Puy', terrain: 'montagne', start: P.clermont, end: P.lePuy },
  { id: 'lille-amiens', label: 'Lille → Amiens', terrain: 'plat', start: P.lille, end: P.amiens },
  { id: 'pau-bayonne', label: 'Pau → Bayonne', terrain: 'vallonné', start: P.pau, end: P.bayonne },
  { id: 'perpignan-foix', label: 'Perpignan → Foix', terrain: 'montagne', start: P.perpignan, end: P.foix },
  { id: 'besancon-geneve', label: 'Besançon → Genève', terrain: 'montagne', start: P.besancon, end: P.geneve },
  { id: 'dijon-lyon', label: 'Dijon → Lyon', terrain: 'vallonné', start: P.dijon, end: P.lyon },
  { id: 'nancy-strasbourg', label: 'Nancy → Strasbourg', terrain: 'vallonné', start: P.nancy, end: P.strasbourg },
  { id: 'marseille-frejus', label: 'Marseille → Fréjus', terrain: 'côtier', start: P.marseille, end: P.frejus },
  { id: 'tours-poitiers', label: 'Tours → Poitiers', terrain: 'plat', start: P.tours, end: P.poitiers },
  { id: 'avignon-gap', label: 'Avignon → Gap', terrain: 'montagne', start: P.avignon, end: P.gap },
  { id: 'bordeaux-bergerac', label: 'Bordeaux → Bergerac', terrain: 'vallonné', start: P.bordeaux, end: P.bergerac },
  { id: 'montpellier-millau', label: 'Montpellier → Millau', terrain: 'montagne', start: P.montpellier, end: P.millau },
  { id: 'lyon-annecy', label: 'Lyon → Annecy', terrain: 'vallonné', start: P.lyon, end: P.annecy },
  { id: 'reims-metz', label: 'Reims → Metz', terrain: 'plat', start: P.reims, end: P.metz },
  { id: 'caen-lemans', label: 'Caen → Le Mans', terrain: 'vallonné', start: P.caen, end: P.leMans },
  { id: 'brest-lorient', label: 'Brest → Lorient', terrain: 'côtier', start: P.brest, end: P.lorient },
  { id: 'toulouse-carcassonne', label: 'Toulouse → Carcassonne', terrain: 'vallonné', start: P.toulouse, end: P.carcassonne },
  { id: 'limoges-clermont', label: 'Limoges → Clermont-Ferrand', terrain: 'vallonné', start: P.limoges, end: P.clermont },
  { id: 'chambery-briancon', label: 'Chambéry → Briançon', terrain: 'montagne', start: P.chambery, end: P.briancon },
  { id: 'bayonne-pamplona', label: 'Bayonne → Pampelune (ES)', terrain: 'montagne', start: P.bayonne, end: P.pamplona },
  { id: 'strasbourg-mulhouse', label: 'Strasbourg → Mulhouse', terrain: 'plat', start: P.strasbourg, end: P.mulhouse },

  // ── 200–500 km ─────────────────────────────────────────────────────
  { id: 'bordeaux-toulouse', label: 'Bordeaux → Toulouse', terrain: 'vallonné', start: P.bordeaux, end: P.toulouse },
  { id: 'lyon-marseille', label: 'Lyon → Marseille', terrain: 'vallonné', start: P.lyon, end: P.marseille },
  { id: 'nantes-bordeaux', label: 'Nantes → Bordeaux', terrain: 'plat', start: P.nantes, end: P.bordeaux },
  { id: 'grenoble-nice', label: 'Grenoble → Nice', terrain: 'montagne', start: P.grenoble, end: P.nice },
  { id: 'clermont-montpellier', label: 'Clermont-Ferrand → Montpellier', terrain: 'montagne', start: P.clermont, end: P.montpellier },
  { id: 'strasbourg-lyon', label: 'Strasbourg → Lyon', terrain: 'vallonné', start: P.strasbourg, end: P.lyon },
  { id: 'paris-nantes', label: 'Paris → Nantes', terrain: 'plat', start: P.paris, end: P.nantes },
  { id: 'toulouse-montpellier', label: 'Toulouse → Montpellier', terrain: 'vallonné', start: P.toulouse, end: P.montpellier },
  { id: 'stetienne-chamonix', label: 'Saint-Étienne → Chamonix', terrain: 'montagne', start: P.stEtienne, end: P.chamonix },
  {
    id: 'alpes-cols-via',
    label: 'Grenoble → Nice par les cols (8 via)',
    terrain: 'montagne',
    start: P.grenoble,
    via: [
      P.bourgOisans,
      { lat: 45.0636, lon: 6.4086 }, // Galibier
      P.briancon,
      { lat: 44.7964, lon: 6.7425 }, // Izoard
      { lat: 44.3858, lon: 6.6517 }, // Barcelonnette
      { lat: 44.3266, lon: 6.8072 }, // Bonette
      { lat: 44.2108, lon: 7.0756 }, // Saint-Sauveur-sur-Tinée
      { lat: 43.9311, lon: 7.1556 }, // Vallée du Var
    ],
    end: P.nice,
  },

  // ── > 500 km ───────────────────────────────────────────────────────
  { id: 'paris-nice', label: 'Paris → Nice', terrain: 'vallonné', start: P.paris, end: P.nice },
  { id: 'brest-strasbourg', label: 'Brest → Strasbourg', terrain: 'vallonné', start: P.brest, end: P.strasbourg },
  { id: 'lille-perpignan', label: 'Lille → Perpignan', terrain: 'vallonné', start: P.lille, end: P.perpignan },
  { id: 'calais-biarritz', label: 'Calais → Biarritz', terrain: 'plat', start: P.calais, end: P.biarritz },
  { id: 'bordeaux-geneve', label: 'Bordeaux → Genève', terrain: 'montagne', start: P.bordeaux, end: P.geneve },
  { id: 'paris-barcelona', label: 'Paris → Barcelone (ES)', terrain: 'vallonné', start: P.paris, end: P.barcelona },
  { id: 'chamonix-paris', label: 'Chamonix → Paris', terrain: 'vallonné', start: P.chamonix, end: P.paris },
  {
    id: 'paris-montpellier-via',
    label: 'Paris → Bordeaux → Toulouse → Montpellier',
    terrain: 'vallonné',
    start: P.paris,
    via: [P.bordeaux, P.toulouse],
    end: P.montpellier,
  },
  {
    id: 'tour-bretagne-15via',
    label: 'Tour de Bretagne (15 via, multi-tronçons)',
    terrain: 'côtier',
    start: P.rennes,
    via: [
      P.stMalo,
      { lat: 48.4554, lon: -2.0503 }, // Dinan
      { lat: 48.5141, lon: -2.7603 }, // Saint-Brieuc
      { lat: 48.7811, lon: -3.0469 }, // Paimpol
      { lat: 48.7326, lon: -3.4566 }, // Lannion
      { lat: 48.5776, lon: -3.8279 }, // Morlaix
      { lat: 48.7262, lon: -3.9853 }, // Roscoff
      P.brest,
      { lat: 48.2422, lon: -4.4894 }, // Crozon
      { lat: 48.0925, lon: -4.3292 }, // Douarnenez
      { lat: 47.996, lon: -4.1024 }, // Quimper
      { lat: 47.8753, lon: -3.9189 }, // Concarneau
      P.lorient,
      { lat: 47.6582, lon: -2.7608 }, // Vannes
      { lat: 47.6517, lon: -2.0848 }, // Redon
    ],
    end: { lat: 48.1147, lon: -1.6794 }, // Rennes (gare)
  },
];

export function haversineKm(a: Pt, b: Pt): number {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

export function routeBeelineKm(route: BenchRoute): number {
  const pts = [route.start, ...(route.via ?? []), route.end];
  let km = 0;
  for (let i = 1; i < pts.length; i += 1) km += haversineKm(pts[i - 1]!, pts[i]!);
  return km;
}

/** Tranche sur la distance réelle attendue (~1.25 × vol d'oiseau). */
export function bandOf(route: BenchRoute): Band {
  const km = routeBeelineKm(route) * 1.25;
  if (km < 100) return '<100';
  if (km < 200) return '100-200';
  if (km < 500) return '200-500';
  return '>500';
}

// ── Configurations ────────────────────────────────────────────────────

export type Activity = 'road' | 'gravel-default' | 'mtb' | 'running' | 'trail';
export type Mode = 'vitesse' | 'aventure' | 'comfort';

export interface BenchConfig {
  id: string;
  label: string;
  family: 'vélo' | 'vélo-variante' | 'running' | 'trail';
  activity: Activity;
  mode: Mode;
  /** Champs `roadTypes` posés par-dessus le preset (comme l'UI). */
  patch?: Record<string, unknown>;
  /** Plage de surfaces appliquée via `syncTracageOnSurfaceRangeChange`. */
  surfaceRange?: ['tarmac' | 'paved' | 'gravel' | 'other', 'tarmac' | 'paved' | 'gravel' | 'other'];
  /** Restreint la config à certains trajets. */
  routes: (r: BenchRoute) => boolean;
}

const ACTIVITY_LABEL: Record<Activity, string> = {
  road: 'Route',
  'gravel-default': 'Gravel',
  mtb: 'VTT',
  running: 'Running',
  trail: 'Trail',
};
const MODE_LABEL: Record<Mode, string> = { vitesse: 'Vitesse', aventure: 'Aventure', comfort: 'Confort' };

const BIKE_ROUTES = (r: BenchRoute) =>
  !['paris-eiffel-vincennes', 'lyon-fourviere-miribel', 'annecy-talloires', 'marseille-cassis', 'grenoble-chamrousse', 'chamonix-courmayeur', 'chamonix-bourgstmaurice'].includes(r.id);

const VARIANT_ROUTES = new Set([
  'lyon-grenoble', 'paris-orleans', 'paris-rouen', 'grenoble-briancon', 'clermont-lepuy', 'lille-amiens',
  'pau-bayonne', 'besancon-geneve', 'marseille-frejus', 'avignon-gap', 'bordeaux-bergerac', 'lyon-annecy',
]);

const RUNNING_ROUTES = new Set([
  'paris-eiffel-vincennes', 'lyon-fourviere-miribel', 'annecy-talloires', 'marseille-aix', 'dijon-beaune',
  'nantes-stnazaire', 'paris-fontainebleau', 'bordeaux-arcachon', 'strasbourg-colmar', 'paris-orleans',
]);

const TRAIL_ROUTES = new Set([
  'valloire-galibier', 'chamonix-martigny', 'chamonix-courmayeur', 'grenoble-chamrousse', 'annecy-talloires',
  'marseille-cassis', 'pau-lourdes', 'annecy-albertville', 'chamonix-bourgstmaurice',
]);

function preset(activity: Activity, mode: Mode, family: BenchConfig['family'], routes: BenchConfig['routes']): BenchConfig {
  return {
    id: `${activity === 'gravel-default' ? 'gravel' : activity}-${mode}`,
    label: `${ACTIVITY_LABEL[activity]} · ${MODE_LABEL[mode]}`,
    family,
    activity,
    mode,
    routes,
  };
}

export const CONFIGS: BenchConfig[] = [
  ...(['road', 'gravel-default', 'mtb'] as const).flatMap((activity) =>
    (['vitesse', 'aventure', 'comfort'] as const).map((mode) => preset(activity, mode, 'vélo', BIKE_ROUTES)),
  ),
  // Variantes « Paramètres additionnels » sur un lot 100–200 km.
  { id: 'road-v+elev-prefer', label: 'Route · Vitesse + Dénivelé privilégier', family: 'vélo-variante', activity: 'road', mode: 'vitesse', patch: { elevationPreference: 'prefer' }, routes: (r) => VARIANT_ROUTES.has(r.id) },
  { id: 'road-v+elev-forbid', label: 'Route · Vitesse + Dénivelé interdire', family: 'vélo-variante', activity: 'road', mode: 'vitesse', patch: { elevationPreference: 'forbid' }, routes: (r) => VARIANT_ROUTES.has(r.id) },
  { id: 'road-v+major-forbid', label: 'Route · Vitesse + Axes majeurs interdits', family: 'vélo-variante', activity: 'road', mode: 'vitesse', patch: { majorRoads: 'forbid' }, routes: (r) => VARIANT_ROUTES.has(r.id) },
  { id: 'road-v+slope6', label: 'Route · Vitesse + Pente max 6 %', family: 'vélo-variante', activity: 'road', mode: 'vitesse', patch: { maxSlopePercent: 6 }, routes: (r) => VARIANT_ROUTES.has(r.id) },
  { id: 'road-c+cities-forbid', label: 'Route · Confort + Villes interdites', family: 'vélo-variante', activity: 'road', mode: 'comfort', patch: { cities: 'forbid' }, routes: (r) => VARIANT_ROUTES.has(r.id) },
  { id: 'gravel-strict-tol0', label: 'Gravel strict (gravel→gravel, tol. 0 %)', family: 'vélo-variante', activity: 'gravel-default', mode: 'vitesse', surfaceRange: ['gravel', 'gravel'], patch: { surfaceTolerance: 0 }, routes: (r) => VARIANT_ROUTES.has(r.id) },
  { id: 'gravel-strict-tol100', label: 'Gravel strict (gravel→gravel, tol. 100 %)', family: 'vélo-variante', activity: 'gravel-default', mode: 'vitesse', surfaceRange: ['gravel', 'gravel'], patch: { surfaceTolerance: 100 }, routes: (r) => VARIANT_ROUTES.has(r.id) },
  { id: 'gravel-v+woods-avoid', label: 'Gravel · Vitesse + Bois à éviter', family: 'vélo-variante', activity: 'gravel-default', mode: 'vitesse', patch: { woods: 'avoid' }, routes: (r) => VARIANT_ROUTES.has(r.id) },
  // Course à pied.
  ...(['vitesse', 'aventure', 'comfort'] as const).map((mode) => preset('running', mode, 'running', (r) => RUNNING_ROUTES.has(r.id))),
  ...(['vitesse', 'aventure', 'comfort'] as const).map((mode) => preset('trail', mode, 'trail', (r) => TRAIL_ROUTES.has(r.id))),
];

export interface Scenario {
  id: string;
  route: BenchRoute;
  config: BenchConfig;
  band: Band;
  beelineKm: number;
}

/**
 * Jeux ad hoc (`--set <nom>`), hors passe complète : une config sur des
 * trajets dédiés.
 */
export const EXTRA_SETS: Record<string, { config: BenchConfig; routes: BenchRoute[] }> = {
  // Gravel, surfaces « gravel → other » : route et axes majeurs interdits.
  'gravel-other': {
    config: {
      id: 'gravel-other',
      label: 'Gravel · surfaces gravel → other',
      family: 'vélo-variante',
      activity: 'gravel-default',
      mode: 'vitesse',
      surfaceRange: ['gravel', 'other'],
      routes: () => true,
    },
    routes: [
      { id: 'paris-milan', label: 'Paris → Milan (IT)', terrain: 'montagne', start: P.paris, end: { lat: 45.4642, lon: 9.19 } },
      { id: 'lyon-geneve', label: 'Lyon → Genève', terrain: 'vallonné', start: P.lyon, end: P.geneve },
      { id: 'bordeaux-toulouse', label: 'Bordeaux → Toulouse', terrain: 'vallonné', start: P.bordeaux, end: P.toulouse },
      { id: 'grenoble-nice', label: 'Grenoble → Nice', terrain: 'montagne', start: P.grenoble, end: P.nice },
      { id: 'paris-montsaintmichel', label: 'Paris → Mont-Saint-Michel', terrain: 'vallonné', start: P.paris, end: { lat: 48.6361, lon: -1.5115 } },
      { id: 'clermont-lepuy', label: 'Clermont-Ferrand → Le Puy', terrain: 'montagne', start: P.clermont, end: P.lePuy },
      { id: 'strasbourg-bale', label: 'Strasbourg → Bâle (CH)', terrain: 'plat', start: P.strasbourg, end: { lat: 47.5596, lon: 7.5886 } },
      { id: 'annecy-chamonix', label: 'Annecy → Chamonix', terrain: 'montagne', start: P.annecy, end: P.chamonix },
      { id: 'marseille-nice', label: 'Marseille → Nice', terrain: 'côtier', start: P.marseille, end: P.nice },
      { id: 'nantes-larochelle', label: 'Nantes → La Rochelle', terrain: 'plat', start: P.nantes, end: { lat: 46.1603, lon: -1.1511 } },
    ],
  },
};

export function buildExtraScenarios(name: string): Scenario[] {
  const set = EXTRA_SETS[name];
  if (!set) throw new Error(`jeu inconnu « ${name} » (disponibles : ${Object.keys(EXTRA_SETS).join(', ')})`);
  return set.routes.map((route) => ({
    id: `${set.config.id}::${route.id}`,
    route,
    config: set.config,
    band: bandOf(route),
    beelineKm: routeBeelineKm(route),
  }));
}

export function buildScenarios(): Scenario[] {
  const out: Scenario[] = [];
  for (const config of CONFIGS) {
    for (const route of ROUTES) {
      if (!config.routes(route)) continue;
      out.push({ id: `${config.id}::${route.id}`, route, config, band: bandOf(route), beelineKm: routeBeelineKm(route) });
    }
  }
  return out;
}

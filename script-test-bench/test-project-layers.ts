/**
 * Couches d'un projet (src/features/itineraryPanel/lib/project/layers.ts) :
 * document partagé / vue de l'utilisateur / travail local. Sortie non nulle au
 * premier échec.
 *
 *  1. Aller-retour : composer les trois couches redonne exactement le projet.
 *  2. Document : ni vue ni travail local, `schema: 2`, profils perso référencés.
 *  3. Anciens projets (projet composé stocké) : vue et travail extraits.
 *  4. Compatibilité : une version précédente de l'app lit un document v2.
 *  5. Classement des modifications (document / vue / travail).
 *  6. Undo/redo : la vue n'entre jamais dans l'historique ni dans une restauration.
 *  7. Identifiants du document : uniques entre éditeurs simultanés.
 *
 *   npx tsx script-test-bench/test-project-layers.ts
 */
import { createDefaultControlPanelPersistedState } from '../src/features/controlPanel/lib/persistedState.ts';
import {
  createDefaultAnalysisPanelState,
  createDefaultItinerary,
  createDefaultProject,
  normalizeItineraryProject,
} from '../src/features/itineraryPanel/lib/project/defaultState.ts';
import { createDocumentId } from '../src/features/itineraryPanel/lib/project/ids.ts';
import {
  applyProjectView,
  classifyProjectChange,
  composeProject,
  extractProjectLocalWork,
  extractProjectView,
  isProjectDocument,
  ITINERARY_LOCAL_WORK_KEYS,
  ITINERARY_VIEW_KEYS,
  PROJECT_DOCUMENT_SCHEMA,
  PROJECT_VIEW_KEYS,
  readStoredProject,
  splitProject,
  stripLocalWork,
  toProjectDocument,
} from '../src/features/itineraryPanel/lib/project/layers.ts';
import {
  diffHistoryDocument,
  restoreHistoryDocument,
  shareProjectStructure,
} from '../src/features/itineraryPanel/context/ProjectStore/historyDocument.ts';
import type {
  Itinerary,
  ItineraryProject,
  SavedCustomProfile,
} from '../src/features/itineraryPanel/types/index.ts';

let failures = 0;
function assert(condition: boolean, message: string): void {
  if (!condition) {
    console.error(`❌ FAILED: ${message}`);
    failures += 1;
    process.exitCode = 1;
    return;
  }
  console.log(`✅ PASSED: ${message}`);
}

/** Égalité JSON (clés `undefined` ignorées, ordre des clés indifférent). */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) => {
    if (inner && typeof inner === 'object' && !Array.isArray(inner)) {
      return Object.fromEntries(
        Object.keys(inner as Record<string, unknown>)
          .sort()
          .map((key) => [key, (inner as Record<string, unknown>)[key]]),
      );
    }
    return inner;
  });
}
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);

function customProfile(id: string, name: string, createdAt: number): SavedCustomProfile {
  const base = createDefaultItinerary(1);
  const { applyToAllItineraries: _ignored, ...roadTypes } = base.roadTypes;
  return { id, name, basePresetId: 'gravel-default', roadTypes, priorities: { ...base.priorities }, createdAt };
}

function richProject(): ItineraryProject {
  const project = createDefaultProject();
  const a: Itinerary = {
    ...createDefaultItinerary(1),
    id: 'it-a',
    profileId: 'custom-a',
    renderMode: 'slope',
    opacity: 60,
    visible: true,
    analysisVisible: false,
    timeline: [
      { id: 'start', kind: 'start', label: 'Chamonix', distanceKm: 0, lat: 45.92, lon: 6.87 },
      { id: 'wp-1', kind: 'waypoint', label: 'Col', distanceKm: 12, lat: 45.95, lon: 6.95 },
      { id: 'end', kind: 'end', label: 'Annecy', distanceKm: 90, lat: 45.9, lon: 6.12 },
    ],
    gpxRoute: {
      name: null,
      source: 'brouter',
      points: [
        { lat: 45.92, lon: 6.87, distanceM: 0, elevationM: 1035 },
        { lat: 45.93, lon: 6.9, distanceM: 2500, elevationM: 1100 },
        { lat: 45.9, lon: 6.12, distanceM: 90000, elevationM: 448 },
      ],
    },
    pendingRoutePatch: {
      start: { lat: 45.92, lon: 6.87, kind: 'start' },
      end: { lat: 45.9, lon: 6.12, kind: 'end' },
      via: [{ lat: 45.95, lon: 6.95 }],
    },
    pendingFitRecompute: true,
  };
  const b: Itinerary = { ...createDefaultItinerary(2), id: 'it-b', profileId: 'road', visible: false };
  return {
    ...project,
    name: 'Tour du Mont-Blanc',
    itineraries: [a, b],
    routingProfiles: [customProfile('custom-a', 'Gravel doux', 1), customProfile('custom-unused', 'Inutilisé', 2)],
    activeItineraryId: 'it-b',
    activeMode: 'rythme',
    timelineView: 'timeline',
    controlPanel: createDefaultControlPanelPersistedState(),
    analysis: { ...createDefaultAnalysisPanelState(), axis2: 'Vitesse' },
    dashboard: {
      rightPanelWidth: 420,
      mapViewport: { center: [6.5, 45.9], zoom: 9.5, pitch: 55, bearing: 12 },
    },
  };
}

// ── 1. Aller-retour ─────────────────────────────────────────────────────────
{
  const project = richProject();
  const layers = splitProject(project);
  const recomposed = composeProject(layers.document, layers.view, layers.work);
  // Le profil inutilisé n'est plus embarqué : c'est la seule différence attendue.
  const expected = { ...project, routingProfiles: project.routingProfiles!.filter((p) => p.id === 'custom-a') };
  assert(same(recomposed, expected), 'composer(document, vue, travail) redonne le projet');
  const viaJson = composeProject(
    JSON.parse(JSON.stringify(layers.document)),
    JSON.parse(JSON.stringify(layers.view)),
    JSON.parse(JSON.stringify(layers.work)),
  );
  assert(same(viaJson, expected), 'aller-retour par JSON (stockage) identique');
  const normalized = normalizeItineraryProject(recomposed);
  assert(normalized.activeItineraryId === 'it-b', 'itinéraire actif conservé après normalisation');
}

// ── 2. Document ─────────────────────────────────────────────────────────────
{
  const project = richProject();
  const resolve = (id: string) => (id === 'custom-a' ? customProfile('custom-a', 'Gravel doux v2', 1) : undefined);
  const document = toProjectDocument(project, { resolveRoutingProfile: resolve });
  assert(document.schema === PROJECT_DOCUMENT_SCHEMA && isProjectDocument(document), 'document marqué schema 2');
  assert(PROJECT_VIEW_KEYS.every((key) => !(key in document)), 'aucun champ de vue dans le document');
  const itineraryKeys = document.itineraries.flatMap((itinerary) => Object.keys(itinerary));
  assert(
    [...ITINERARY_VIEW_KEYS, ...ITINERARY_LOCAL_WORK_KEYS].every((key) => !itineraryKeys.includes(key)),
    'aucun affichage ni travail local dans les itinéraires du document',
  );
  assert(
    document.routingProfiles?.length === 1 && document.routingProfiles[0].name === 'Gravel doux v2',
    'profils perso : seuls les référencés, version de la bibliothèque prioritaire',
  );
  const fallback = toProjectDocument(project);
  assert(fallback.routingProfiles?.[0]?.name === 'Gravel doux', 'profil absent de la bibliothèque : copie embarquée gardée');
  const noCustom = toProjectDocument({ ...project, itineraries: [project.itineraries[1]] });
  assert(!('routingProfiles' in noCustom), 'aucun profil perso utilisé : pas de clé routingProfiles');
  assert(
    project.itineraries[0].gpxRoute!.points === document.itineraries[0].gpxRoute!.points,
    'points du tracé partagés par référence (pas de copie)',
  );
  assert(
    JSON.stringify(toProjectDocument(project, { resolveRoutingProfile: resolve }))
      === JSON.stringify(document),
    'sérialisation du document déterministe',
  );
  const view = extractProjectView(project);
  assert(
    view.activeMode === 'rythme' && view.itineraries['it-a']?.opacity === 60 && view.itineraries['it-b']?.visible === false,
    'vue : champs du projet et affichage par itinéraire',
  );
  const work = extractProjectLocalWork(project);
  assert(
    Object.keys(work.itineraries).join() === 'it-a' && work.itineraries['it-a'].pendingFitRecompute === true,
    'travail local : seulement les itinéraires concernés',
  );
}

// ── 3. Anciens projets ──────────────────────────────────────────────────────
{
  const legacy = richProject();
  delete legacy.routingProfiles;
  const stored = readStoredProject(JSON.parse(JSON.stringify(legacy)));
  assert(stored != null && stored.legacyView != null && stored.legacyWork != null, 'ancien projet : vue et travail extraits');
  const recomposed = composeProject(stored!.document, stored!.legacyView, stored!.legacyWork);
  assert(same(recomposed, legacy), 'ancien projet relu à l’identique');
  const v2 = readStoredProject(JSON.parse(JSON.stringify(toProjectDocument(legacy))));
  assert(v2 != null && v2.legacyView === null && v2.legacyWork === null, 'document v2 : ni vue ni travail embarqués');
  assert(readStoredProject({ name: 'x' }) === null && readStoredProject(null) === null, 'valeur non projet rejetée');
}

// ── 4. Compatibilité avec une version précédente ────────────────────────────
{
  const document = toProjectDocument(richProject());
  const oldClient = normalizeItineraryProject(JSON.parse(JSON.stringify(document)) as ItineraryProject);
  assert(
    oldClient.itineraries.length === 2
      && oldClient.activeItineraryId === 'it-a'
      && oldClient.itineraries[0].timeline.length === 3,
    'une version précédente lit le document v2 (vue par défaut, contenu intact)',
  );
}

// ── 5. Classement des modifications ─────────────────────────────────────────
{
  const prev = shareProjectStructure(richProject(), richProject());
  const share = (next: ItineraryProject) => shareProjectStructure(prev, next);
  const it = (index: number, patch: Partial<Itinerary>) => ({
    ...prev,
    itineraries: prev.itineraries.map((itinerary, i) => (i === index ? { ...itinerary, ...patch } : itinerary)),
  });
  const viewOnly = [
    share({ ...prev, activeMode: 'poi' }),
    share({ ...prev, activeItineraryId: 'it-a' }),
    share({
      ...prev,
      controlPanel: {
        ...prev.controlPanel!,
        toggles: { ...prev.controlPanel!.toggles, contourLinesEnabled: !prev.controlPanel!.toggles.contourLinesEnabled },
      },
    }),
    share({ ...prev, dashboard: { ...prev.dashboard, rightPanelWidth: 500 } }),
    share(it(0, { opacity: 30 })),
    share(it(1, { visible: true, analysisVisible: true })),
    share(it(0, { renderMode: 'default' })),
  ];
  assert(
    viewOnly.every((next) => {
      const change = classifyProjectChange(prev, next);
      return change.view && !change.document && !change.work;
    }),
    'vue seule : mode, itinéraire actif, panneau de droite, panneaux, œil, opacité, rendu',
  );
  const docChange = classifyProjectChange(prev, share(it(0, { name: 'Variante' })));
  assert(docChange.document && !docChange.view && !docChange.work, 'renommer un itinéraire : document seul');
  const nameChange = classifyProjectChange(prev, share({ ...prev, name: 'Autre' }));
  assert(nameChange.document && !nameChange.view, 'renommer le projet : document');
  const workChange = classifyProjectChange(prev, share(it(0, { pendingRoutePatch: undefined })));
  assert(workChange.work && !workChange.document && !workChange.view, 'édition en attente consommée : travail seul');
  const structural = classifyProjectChange(prev, share({ ...prev, itineraries: [prev.itineraries[1]] }));
  assert(structural.document, 'suppression d’un itinéraire : document');
  const nothing = classifyProjectChange(prev, share(richProject()));
  assert(!nothing.document && !nothing.view && !nothing.work, 'état identique recréé : rien à enregistrer');
  // Ouverture : le Dashboard et le ProjectStore normalisent chacun le projet
  // (objets recréés, mêmes valeurs) ; le 1er changement de vue reste une vue.
  const dashboardSnapshot = normalizeItineraryProject(richProject());
  const storeState = normalizeItineraryProject(dashboardSnapshot);
  const firstChange = classifyProjectChange(dashboardSnapshot, { ...storeState, activeMode: 'poi' });
  assert(
    firstChange.view && !firstChange.document && !firstChange.work,
    'premier changement de vue après l’ouverture (projet renormalisé) : vue seule',
  );
}

// ── 6. Undo / redo ──────────────────────────────────────────────────────────
{
  const prev = richProject();
  const opacityOnly = { ...prev, itineraries: prev.itineraries.map((it, i) => (i === 0 ? { ...it, opacity: 10, renderMode: 'default' as const } : it)) };
  assert(diffHistoryDocument(prev, opacityOnly) === null, 'opacité / rendu : pas d’étape d’annulation');
  const renamed = { ...opacityOnly, itineraries: opacityOnly.itineraries.map((it, i) => (i === 0 ? { ...it, name: 'Renommé' } : it)) };
  assert(diffHistoryDocument(opacityOnly, renamed)?.itineraryId === 'it-a', 'renommage : étape d’annulation');
  // Annuler le renommage garde l'affichage courant (opacité 10, rendu par défaut).
  const restored = restoreHistoryDocument(renamed, prev, 'it-b');
  assert(
    restored.itineraries[0].name === prev.itineraries[0].name
      && restored.itineraries[0].opacity === 10
      && restored.itineraries[0].renderMode === 'default',
    'restauration : document de l’instantané, affichage courant',
  );
  assert(restored.itineraries[1].visible === true, 'restauration : l’itinéraire concerné redevient visible');
}

// ── 7. Identifiants ─────────────────────────────────────────────────────────
{
  const ids = new Set<string>();
  for (let i = 0; i < 20_000; i += 1) ids.add(createDocumentId('wp'));
  assert(ids.size === 20_000, '20 000 ids créés dans la même milliseconde : tous distincts');
  const sample = createDocumentId('it');
  assert(/^it-[0-9a-z]+-[0-9a-z]{10}$/.test(sample), `format lisible (${sample})`);
  const itinerary = createDefaultItinerary(1);
  assert(itinerary.id.startsWith('it-') && itinerary.id !== createDefaultItinerary(1).id, 'itinéraires créés au même instant : ids distincts');
}

// ── 8. Application d'une vue ────────────────────────────────────────────────
{
  const project = richProject();
  const view = extractProjectView(project);
  const fresh = composeProject(toProjectDocument(project));
  assert(fresh.activeMode === 'tracage' && fresh.activeItineraryId === 'it-a', 'sans vue : valeurs d’un projet neuf');
  const withView = applyProjectView(fresh, { ...view, itineraries: { ...view.itineraries, 'it-inconnu': { visible: false } } });
  assert(
    withView.activeMode === 'rythme' && withView.itineraries[0].opacity === 60 && withView.itineraries.length === 2,
    'vue appliquée ; itinéraire inconnu de la vue ignoré',
  );
  const stripped = stripLocalWork(project);
  assert(
    stripped.itineraries.every((itinerary) => ITINERARY_LOCAL_WORK_KEYS.every((key) => itinerary[key] === undefined)),
    'export : travail local retiré',
  );
  assert(stripLocalWork(stripped) === stripped, 'export : projet sans travail local inchangé (même objet)');
}

if (failures > 0) {
  console.error(`\n${failures} échec(s)`);
} else {
  console.log('\nCouches du projet : tout est conforme.');
}

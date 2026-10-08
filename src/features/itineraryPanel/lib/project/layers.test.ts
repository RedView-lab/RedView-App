import { describe, expect, it } from 'vitest';

import type { Itinerary, ItineraryProject, SavedCustomProfile } from '../../types';
import { createDefaultItinerary, createDefaultProject } from './defaultState';
import {
  applyProjectView,
  classifyProjectChange,
  composeProject,
  extractProjectView,
  readStoredProject,
  splitProject,
  stripLocalWork,
  toProjectDocument,
} from './layers';

/**
 * Couches d'un projet : ce qui part dans le document partagé, ce qui reste à
 * chaque utilisateur (vue) ou à cet appareil (travail en attente), et quelle
 * sauvegarde déclenche un changement.
 */

function projectWith(...itineraries: Itinerary[]): ItineraryProject {
  return { ...createDefaultProject(), name: 'Tour', itineraries, activeItineraryId: itineraries[0]?.id ?? '' };
}

const pendingPatch = { kind: 'patch' } as unknown as Itinerary['pendingRoutePatch'];

describe('classifyProjectChange', () => {
  const it1 = createDefaultItinerary(1);
  const it2 = createDefaultItinerary(2);
  const base = projectWith(it1, it2);

  it('même objet : rien à sauvegarder', () => {
    expect(classifyProjectChange(base, base)).toEqual({ document: false, view: false, work: false });
  });

  it('changement de vue seule (itinéraire actif, panneau, œil, opacité) : jamais le document', () => {
    expect(classifyProjectChange(base, { ...base, activeItineraryId: it2.id })).toEqual({ document: false, view: true, work: false });
    expect(classifyProjectChange(base, { ...base, dashboard: { ...base.dashboard } as ItineraryProject['dashboard'] })).toEqual({ document: false, view: true, work: false });
    const hidden = { ...base, itineraries: [{ ...it1, visible: false, opacity: 0.4 }, it2] };
    expect(classifyProjectChange(base, hidden)).toEqual({ document: false, view: true, work: false });
  });

  it('travail en attente seul : ni document ni vue', () => {
    const pending = { ...base, itineraries: [{ ...it1, pendingRoutePatch: pendingPatch }, it2] };
    expect(classifyProjectChange(base, pending)).toEqual({ document: false, view: false, work: true });
  });

  it('contenu d’un itinéraire ou du projet : le document', () => {
    expect(classifyProjectChange(base, { ...base, name: 'Autre nom' }).document).toBe(true);
    expect(classifyProjectChange(base, { ...base, itineraries: [{ ...it1, name: 'Variante' }, it2] }).document).toBe(true);
  });

  it('une valeur égale recréée (normalisation) ne déclenche pas de sauvegarde du document', () => {
    const recreated = { ...base, itineraries: [JSON.parse(JSON.stringify(it1)) as Itinerary, it2], privacy: base.privacy };
    expect(classifyProjectChange(base, recreated).document).toBe(false);
    const withProfiles = { ...base, routingProfiles: [{ id: 'prof-1', name: 'Gravel' } as SavedCustomProfile] };
    const reread = { ...withProfiles, routingProfiles: JSON.parse(JSON.stringify(withProfiles.routingProfiles)) as SavedCustomProfile[] };
    expect(classifyProjectChange(withProfiles, reread).document).toBe(false);
    expect(classifyProjectChange(withProfiles, { ...reread, routingProfiles: [] }).document).toBe(true);
    const sameWork = { ...base, itineraries: [{ ...it1, pendingRoutePatch: pendingPatch }, it2] };
    const sameWorkCopy = { ...sameWork, itineraries: [{ ...sameWork.itineraries[0]!, pendingRoutePatch: { ...pendingPatch! } }, it2] };
    expect(classifyProjectChange(sameWork, sameWorkCopy).work).toBe(false);
  });

  it('ajout, suppression ou réordonnancement d’itinéraires : les trois couches', () => {
    const all = { document: true, view: true, work: true };
    expect(classifyProjectChange(base, projectWith(it1))).toEqual(all);
    expect(classifyProjectChange(base, projectWith(it2, it1))).toEqual(all);
    expect(classifyProjectChange(base, projectWith(it1, it2, createDefaultItinerary(3)))).toEqual(all);
  });
});

describe('découpe et recomposition', () => {
  const profile = { id: 'prof-1', name: 'Gravel' } as SavedCustomProfile;
  const unused = { id: 'prof-old', name: 'Ancien' } as SavedCustomProfile;
  const it1 = { ...createDefaultItinerary(1), profileId: 'prof-1', visible: false, opacity: 0.5, pendingFitRecompute: true } as Itinerary;
  const project = { ...projectWith(it1), activeMode: 'rythme', routingProfiles: [profile, unused] } as ItineraryProject;

  it('le document ne porte ni la vue ni le travail local, et seulement les profils référencés', () => {
    const document = toProjectDocument(project);
    expect(document.schema).toBe(2);
    expect('activeMode' in document).toBe(false);
    expect('activeItineraryId' in document).toBe(false);
    const [itinerary] = document.itineraries;
    expect(itinerary && 'visible' in itinerary).toBe(false);
    expect(itinerary && 'opacity' in itinerary).toBe(false);
    expect(itinerary && 'pendingFitRecompute' in itinerary).toBe(false);
    expect(document.routingProfiles?.map((entry) => entry.id)).toEqual(['prof-1']);
  });

  it('la version de la bibliothèque du compte remplace la copie embarquée', () => {
    const library = { id: 'prof-1', name: 'Gravel v2' } as SavedCustomProfile;
    expect(toProjectDocument(project, { resolveRoutingProfile: (id) => (id === 'prof-1' ? library : undefined) }).routingProfiles).toEqual([library]);
  });

  it('document + vue + travail redonnent le projet d’interface', () => {
    const { document, view, work } = splitProject(project);
    const composed = composeProject(document, view, work);
    expect(composed.activeMode).toBe('rythme');
    expect(composed.itineraries[0]).toMatchObject({ visible: false, opacity: 0.5, pendingFitRecompute: true, profileId: 'prof-1' });
    // Sans vue : valeurs d'un projet neuf.
    expect(composeProject(document).activeMode).toBe('tracage');
    expect(composeProject(document).activeItineraryId).toBe(it1.id);
  });

  it('un itinéraire inchangé redonne le même itinéraire du document (comparaison par référence en co-édition)', () => {
    expect(toProjectDocument(project).itineraries[0]).toBe(toProjectDocument(project).itineraries[0]);
    const withView = applyProjectView(project, { itineraries: { [it1.id]: { opacity: 0.9 } } });
    expect(toProjectDocument(withView).itineraries[0]).toBe(toProjectDocument(project).itineraries[0]);
  });

  it('appliquer une vue : seuls ses champs changent, un itinéraire inconnu de la vue est inchangé', () => {
    const view = extractProjectView({ ...project, activeMode: 'tracage' });
    const applied = applyProjectView(project, { ...view, itineraries: {} });
    expect(applied.activeMode).toBe('tracage');
    expect(applied.itineraries[0]).toBe(project.itineraries[0]);
    expect(applyProjectView(project, null)).toBe(project);
  });

  it('un fichier envoyé à un tiers n’emporte pas le travail en attente', () => {
    const stripped = stripLocalWork(project);
    expect('pendingFitRecompute' in stripped.itineraries[0]!).toBe(false);
    const clean = projectWith(createDefaultItinerary(1));
    expect(stripLocalWork(clean)).toBe(clean);
  });
});

describe('readStoredProject', () => {
  it('document actuel : lu tel quel, sans vue ni travail hérités', () => {
    const document = toProjectDocument(projectWith(createDefaultItinerary(1)));
    expect(readStoredProject(document)).toEqual({ document, legacyView: null, legacyWork: null });
  });

  it('ancien projet composé : sa vue et son travail en attente sont extraits', () => {
    const it1 = { ...createDefaultItinerary(1), visible: false, pendingRoutePatch: pendingPatch } as Itinerary;
    const legacy = { ...projectWith(it1), activeMode: 'rythme' } as ItineraryProject;
    const read = readStoredProject(JSON.parse(JSON.stringify(legacy)));
    expect(read?.document.schema).toBe(2);
    expect(read?.legacyView?.activeMode).toBe('rythme');
    expect(read?.legacyView?.itineraries[it1.id]).toEqual({ visible: false, analysisVisible: true });
    expect(read?.legacyWork?.itineraries[it1.id]).toEqual({ pendingRoutePatch: pendingPatch });
  });

  it('valeur illisible : null', () => {
    expect(readStoredProject(null)).toBeNull();
    expect(readStoredProject({ name: 'sans itinéraires' })).toBeNull();
  });
});

/**
 * Rapports Umami de RedView, versionnés : entonnoirs, objectifs et segments
 * appliqués par `npm run analytics:sync` (scripts/analytics/umami/sync.ts, idempotent
 * par nom). La spec cite les noms du code (événements de
 * src/shared/lib/analytics/events.ts, écrans de screens.ts) ; la synchro les
 * traduit avec les mêmes tables que l'app (labels.ts) : ce qu'Umami reçoit et ce
 * que les rapports cherchent ne peuvent pas diverger. Les descriptions sont
 * écrites pour quelqu'un qui n'a jamais ouvert le code.
 *
 * Contraintes Umami 3.4 (src/lib/schema.ts) : entonnoir de 2 à 8 étapes,
 * fenêtre en minutes entre deux étapes, filtres d'étape sur les propriétés de
 * l'événement (`eq`, `neq`, `c`, `dnc`). Une « personne » pour Umami = même
 * réseau + même navigateur dans le mois : un entonnoir sur plusieurs jours sous-
 * estime un peu (changement d'appareil, de réseau, de mois). La rétention par
 * compte se lit dans la base (npm run analytics:report).
 */
import type { AnalyticsEvent } from '../../../src/shared/lib/analytics/events.ts';
import type { AnalyticsScreen } from '../../../src/shared/lib/analytics/screens.ts';

type EventName = AnalyticsEvent['name'];

export interface StepFilter {
  /** Propriété du code (`outcome`, `account_age`…) et valeur du code (`ok`, `d0`…). */
  property: string;
  operator: 'eq' | 'neq' | 'c' | 'dnc';
  value: string;
}

export type FunnelStep =
  | { type: 'screen'; screen: AnalyticsScreen }
  | { type: 'event'; event: EventName; filters?: StepFilter[] };

export interface FunnelSpec {
  name: string;
  description: string;
  /** Minutes autorisées entre deux étapes consécutives. */
  window: number;
  steps: FunnelStep[];
}

export interface GoalSpec {
  name: string;
  description: string;
  event: EventName;
}

export interface SegmentSpec {
  name: string;
  filters: Array<{ name: string; operator: 'eq' | 'neq' | 'c' | 'dnc' | 're'; value: string }>;
}

const HOUR = 60;
const DAY = 24 * HOUR;
const event = (name: EventName, filters?: StepFilter[]): FunnelStep => ({ type: 'event', event: name, ...(filters ? { filters } : {}) });
const screen = (name: AnalyticsScreen): FunnelStep => ({ type: 'screen', screen: name });
const newAccount: StepFilter[] = [{ property: 'account_age', operator: 'eq', value: 'd0' }];

export const FUNNELS: FunnelSpec[] = [
  {
    name: '1. Activation : de l’inscription au GPS',
    description: 'Sur 100 personnes qui arrivent sur la page d’inscription, combien créent leur compte, puis un projet, tracent un itinéraire et l’exportent vers leur GPS (moins de 7 jours entre deux étapes). La plus grosse chute montre où les nouveaux décrochent.',
    window: 7 * DAY,
    steps: [screen('signup'), event('signup_completed'), event('project_created'), event('route_calculated'), event('route_exported')],
  },
  {
    name: '2. Première journée des nouveaux comptes',
    description: 'Comptes créés le jour même : projet, itinéraire, tracé, export, le tout dans la journée. Montre si l’app se comprend seule, sans aide.',
    window: DAY,
    steps: [
      event('project_created', newAccount),
      event('itinerary_added', newAccount),
      event('route_calculated', newAccount),
      event('route_exported', newAccount),
    ],
  },
  {
    name: '3. Retour sur un projet jusqu’à l’export',
    description: 'Quelqu’un rouvre un projet enregistré : le retravaille-t-il jusqu’à exporter le parcours dans la même séance (2 h) ? C’est l’usage « préparer sa sortie ».',
    window: 2 * HOUR,
    steps: [event('project_opened'), event('route_calculated'), event('route_exported')],
  },
  {
    name: '4. Travailler à plusieurs',
    description: 'Fenêtre de partage ouverte, invitation envoyée, puis vraie session à plusieurs (moins de 7 jours entre deux étapes).',
    window: 7 * DAY,
    steps: [event('share_dialog_opened'), event('share_invite_sent'), event('collab_session_joined')],
  },
  {
    name: '5. LiDAR : télécharger, ouvrir, analyser',
    description: 'Une tuile LiDAR téléchargée sans erreur, le viewer ouvert, puis un outil d’analyse utilisé (mesure, pente, avalanche…) dans la journée.',
    window: DAY,
    steps: [
      event('lidar_tile_downloaded', [{ property: 'outcome', operator: 'eq', value: 'ok' }]),
      event('lidar_viewer_opened'),
      event('lidar_tool_used'),
    ],
  },
  {
    name: '6. Survol 3D jusqu’à la vidéo',
    description: 'Survol 3D lancé, regardé jusqu’au bout, puis vidéo MP4 exportée avec succès, dans la journée.',
    window: DAY,
    steps: [
      event('flyover_played'),
      event('flyover_finished', [{ property: 'completed', operator: 'eq', value: '100' }]),
      event('flyover_video_exported', [{ property: 'outcome', operator: 'eq', value: 'done' }]),
    ],
  },
  {
    name: '7. Abonnement',
    description: 'Page Abonnement vue, paiement commencé, paiement confirmé (dans la journée). Le paiement n’est pas encore ouvert : rester à zéro est normal.',
    window: DAY,
    steps: [screen('projects_subscription'), event('checkout_started'), event('checkout_completed')],
  },
];

export const GOALS: GoalSpec[] = [
  { name: 'Nouveaux comptes', description: 'Personnes qui ont créé leur compte (e-mail ou Google).', event: 'signup_completed' },
  { name: 'Parcours envoyés vers un GPS', description: 'LE signe qu’un parcours a servi : un fichier GPX, KML ou FIT téléchargé pour le GPS ou l’appli de navigation.', event: 'route_exported' },
  { name: 'Invitations à collaborer', description: 'Personnes invitées à modifier un projet avec quelqu’un.', event: 'share_invite_sent' },
  { name: 'Vidéos de survol', description: 'Exports de la vidéo du survol 3D (toutes issues : le détail dit si elle est terminée).', event: 'flyover_video_exported' },
  { name: 'Ouvertures du viewer LiDAR', description: 'Personnes qui ont ouvert le nuage de points LiDAR en 3D.', event: 'lidar_viewer_opened' },
  { name: 'Abonnements payés', description: 'Paiements confirmés (le paiement n’est pas encore ouvert).', event: 'checkout_completed' },
];

export const SEGMENTS: SegmentSpec[] = [
  { name: 'Navigateur en anglais', filters: [{ name: 'language', operator: 'c', value: 'en' }] },
  { name: 'Arrivés depuis Instagram', filters: [{ name: 'referrer', operator: 'c', value: 'instagram' }] },
  { name: 'Arrivés depuis le site vitrine', filters: [{ name: 'referrer', operator: 'c', value: 'redview.tech' }] },
  { name: 'Arrivés par une campagne (lien UTM)', filters: [{ name: 'utmSource', operator: 're', value: '.+' }] },
  { name: 'Sur téléphone ou tablette', filters: [{ name: 'device', operator: 're', value: '^(mobile|tablet)$' }] },
];

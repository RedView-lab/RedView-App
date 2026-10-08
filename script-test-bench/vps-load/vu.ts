/**
 * Utilisateur virtuel du banc de charge du VPS : rejoue, avec un vrai compte
 * de production, les requêtes que l'app envoie au VPS pour chaque geste —
 * séquences relevées par calibrate.mjs dans un vrai Edge (2026-10-08) et lues
 * dans le code :
 *
 *  - arrivée : `GET /` (+ toutes les ressources sur un premier passage, le
 *    Service Worker et ses scripts compris), puis le tableau de bord —
 *    `account.get` ×2, JWT, liste des projets (Query.select), dossiers,
 *    équipes, `/api/billing/overview`, `/multiplayer/health` ;
 *  - ouverture d'un projet : ligne complète (`data`), vue de l'utilisateur
 *    (`project_views`, créée au premier passage), miniature ;
 *  - tracé : le VRAI pipeline de routage de l'app (resolveRouteRequest, chargé
 *    par le SSR de Vite comme bench:routing : profil BRF, ancres longue
 *    distance, doublage des recherches lentes, délais), puis la météo du tracé
 *    (`/api/openmeteo`, stations de `sampleRouteForWeather`) et les sauvegardes
 *    automatiques qui suivent ;
 *  - sauvegarde automatique : GET de la version puis PATCH de `data` (la vraie
 *    charge `gz:` du projet) ; vue : PATCH `project_views` ;
 *  - co-édition (projet partagé) : WebSocket `redview.v4` avec un JWT, état
 *    complet du `welcome` désérialisé, lots des autres appliqués, et un nouveau
 *    tracé calculé par `diffDocument` sur cet état (seuls les morceaux de route
 *    nouveaux partent, en trame raw-DEFLATE au-delà de 16 Kio comme l'app),
 *    bail de calcul demandé / rendu, pointeur en direct à 20 Hz.
 *
 * Ce qui n'est PAS joué : les tuiles de carte (Mapbox, IGN, AWS : hors VPS),
 * les calculs du navigateur, et les envois Umami (`/s/api/send`) — ils
 * fausseraient les statistiques de l'équipe.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { deflateRawSync, inflateRawSync } from 'node:zlib';

import { Account, AppwriteException, Client, Databases, Permission, Query, Role, Storage, Teams } from 'appwrite';
import { WebSocket } from 'ws';

import { diffDocument } from '../../src/features/collab/model/diff.ts';
import { Materializer } from '../../src/features/collab/model/materialize.ts';
import { applyOps } from '../../src/features/collab/model/ops.ts';
import type { ObjectStore } from '../../src/features/collab/model/objects.ts';
import { deserializeStore, PROTOCOL_VERSION, socketProtocols, type ServerMessage } from '../../src/features/collab/protocol.ts';
import { WIRE_COMPRESS_MIN_CHARS } from '../../src/features/collab/wire.ts';
import type { Budget, Random, Sample } from './lib.ts';
import { haversineM, jitterPoint, sleep } from './lib.ts';
import type { FixturePayload, FixtureSize, OwnProject, Room } from './fixtures.ts';
import type { LoadTestSession } from './accounts.ts';

/* eslint-disable @typescript-eslint/no-explicit-any */

export const DATABASE_ID = 'redview-db';
const PROJECT_META_FIELDS = ['$id', '$createdAt', '$updatedAt', '$permissions', 'user_id', 'folder_id', 'name', 'size_bytes', 'privacy', 'team_id'];
const REQUEST_TIMEOUT_MS = 30_000;

/** Contexte réseau de l'utilisateur virtuel courant, lu par le `fetch` du pipeline de routage. */
export interface VuNet {
  vu: string;
  calls: number;
  statuses: number[];
}
export const vuNet = new AsyncLocalStorage<VuNet>();

/** Pipeline de routage de l'app chargé une fois par processus (voir worker.ts). */
export interface RoutingKit {
  buildItinerary(config: any): any;
  resolveRouteRequest(args: any): Promise<{ route: { coordinates: number[][] } }>;
  clearProfileCache(): void;
  configs: any[];
  routes: Array<{ id: string; start: { lat: number; lon: number }; end: { lat: number; lon: number }; beelineKm: number }>;
}

export interface VuShared {
  appUrl: string;
  appwriteEndpoint: string;
  appwriteProject: string;
  payloads: Record<FixtureSize, FixturePayload>;
  /** Ressources d'un premier passage (relevé de calibrage) : chemins de l'app. */
  coldAssets: string[];
  coldShare: number;
  routing: RoutingKit;
  /** Budget d'API de ce processus (part de la limite par IP du portable). */
  apiBudget: Budget;
  record(sample: Sample): void;
  /** Horloge commune des lots de co-édition (salles entières dans un même processus). */
  sentAt: Map<string, number>;
}

export interface VuSpec {
  session: LoadTestSession;
  own: OwnProject[];
  room: Room | null;
  random: Random;
  configIndex: number;
}

/** Trames temps réel de ce processus (ajoutées au relevé d'octets de worker.ts). */
export const wsTraffic = { up: 0, down: 0 };

function errorWhy(error: unknown): string {
  if (error instanceof AppwriteException) return `aw ${error.code || 'réseau'}${error.type ? ` ${error.type}` : ''}`;
  const message = String((error as Error)?.message ?? error);
  if (/abort|timeout|délai/i.test(message)) return 'délai';
  if (/budget/.test(message)) return 'budget-ip';
  return message.slice(0, 60);
}

/** Nombre de stations météo d'un tracé (src/features/weather/lib/routeWeather.ts, sampleRouteForWeather). */
function weatherStationCount(totalM: number): number {
  if (totalM <= 5_000) return 3;
  if (totalM <= 25_000) return Math.max(4, Math.min(8, Math.round(totalM / 3_500)));
  if (totalM <= 80_000) return Math.max(8, Math.min(16, Math.round(totalM / 5_000)));
  return Math.max(16, Math.min(26, Math.round(totalM / 7_000)));
}

function projectViewDocumentId(projectId: string, userId: string): string {
  // Copie de src/shared/services/projects/projectViews.ts (cyrb53) : même id que l'app.
  const hash53 = (value: string, seed: number) => {
    let h1 = 0xdeadbeef ^ seed;
    let h2 = 0x41c6ce57 ^ seed;
    for (let i = 0; i < value.length; i += 1) {
      const ch = value.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
    h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
    h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return 4294967296 * (2097151 & h2) + (h1 >>> 0);
  };
  const key = `${projectId}:${userId}`;
  return `pv${hash53(key, 1).toString(16).padStart(14, '0')}${hash53(key, 2).toString(16).padStart(14, '0')}`;
}

/** Vue d'un utilisateur (~6 Kio comme celles relevées : mode, panneaux, analyse). */
function viewData(random: Random, itineraryId: string): string {
  const view = {
    activeItineraryId: itineraryId,
    activeMode: random.pick(['tracage', 'rythme', 'poi', 'nutrition']),
    mapViewport: { center: [6 + random.next(), 45 + random.next()], zoom: 9 + random.next() * 4, bearing: 0, pitch: 55 },
    controlPanel: Object.fromEntries(Array.from({ length: 60 }, (_, index) => [`reglage${index}`, { visible: random.chance(0.5), opacity: Math.round(random.next() * 100) / 100, mode: 'auto' }])),
    analysis: { axis: 'distance', series: ['altitude', 'pente', 'vitesse'], zoom: [0, 1] },
  };
  return JSON.stringify({ updatedAt: new Date().toISOString(), view });
}

export class VirtualUser {
  readonly id: string;
  private readonly client: Client;
  private readonly account: Account;
  private readonly databases: Databases;
  private readonly storage: Storage;
  private readonly teams: Teams;
  private readonly itinerary: any;
  private route: { start: { lat: number; lon: number }; end: { lat: number; lon: number } };
  private projectIndex = 0;
  private jwt: string | null = null;
  private viewCreated = false;
  private socket: CollabSocket | null = null;
  stopped = false;

  private readonly shared: VuShared;
  private readonly spec: VuSpec;

  constructor(shared: VuShared, spec: VuSpec) {
    this.shared = shared;
    this.spec = spec;
    this.id = `vu-${String(spec.session.index).padStart(3, '0')}`;
    this.client = new Client().setEndpoint(shared.appwriteEndpoint).setProject(shared.appwriteProject).setSession(spec.session.secret);
    this.account = new Account(this.client);
    this.databases = new Databases(this.client);
    this.storage = new Storage(this.client);
    this.teams = new Teams(this.client);
    const config = shared.routing.configs[spec.configIndex % shared.routing.configs.length];
    this.itinerary = shared.routing.buildItinerary(config);
    this.route = this.pickRoute();
  }

  private get random(): Random {
    return this.spec.random;
  }

  /** Trajets réalistes : 60 % < 100 km, 30 % 100–200, 8 % 200–500, 2 % > 500 (à vol d'oiseau). */
  private pickRoute() {
    const band = this.random.weighted([['<100', 60], ['100-200', 30], ['200-500', 8], ['>500', 2]] as const);
    const inBand = this.shared.routing.routes.filter((route) => {
      const km = route.beelineKm;
      return band === '<100' ? km < 100 : band === '100-200' ? km >= 100 && km < 200 : band === '200-500' ? km >= 200 && km < 500 : km >= 500;
    });
    const route = this.random.pick(inBand.length ? inBand : this.shared.routing.routes);
    return { start: route.start, end: route.end };
  }

  private record(name: string, startedAt: number, ok: boolean, why?: string): number {
    const ms = Math.round(performance.now() - startedAt);
    this.shared.record({ name, ms, ok, at: Date.now(), ...(why ? { why } : {}) });
    return ms;
  }

  /** Appel Appwrite chronométré ; l'erreur est notée (sauf un 404 attendu) puis relancée. */
  private async aw<T>(name: string, run: () => Promise<T>, { expect404 = false } = {}): Promise<T> {
    const t0 = performance.now();
    try {
      const result = await run();
      this.record(name, t0, true);
      return result;
    } catch (error) {
      const expected = expect404 && error instanceof AppwriteException && error.code === 404;
      this.record(name, t0, expected, expected ? undefined : errorWhy(error));
      throw error;
    }
  }

  /** Requête vers l'app (statique, /api, /multiplayer/health), corps entièrement lu. */
  private async http(name: string, path: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<Response | null> {
    const t0 = performance.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), init.timeoutMs ?? REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(`${this.shared.appUrl}${path}`, {
        ...init,
        headers: { 'accept-encoding': 'br, gzip', ...(init.headers as Record<string, string> | undefined) },
        signal: controller.signal,
      });
      await response.arrayBuffer();
      // 429 de server.mjs : la limite par IP du portable (tout le générateur), pas le VPS.
      this.record(name, t0, response.ok, response.ok ? undefined : response.status === 429 ? 'budget-ip' : `http ${response.status}`);
      return response;
    } catch (error) {
      this.record(name, t0, false, errorWhy(error));
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  private async apiCall(name: string, path: string, init: RequestInit = {}): Promise<boolean> {
    if (!this.shared.apiBudget.reserve(1)) {
      this.shared.record({ name, ms: 0, ok: false, at: Date.now(), why: 'budget-ip' });
      return false;
    }
    const response = await this.http(name, path, init);
    return !!response?.ok;
  }

  // ── Arrivée et tableau de bord ───────────────────────────────────────────

  async arrive(cold: boolean): Promise<void> {
    const t0 = performance.now();
    await this.http('statique.page', '/');
    if (cold) {
      // Le navigateur charge ~6 ressources en parallèle par domaine sur une
      // connexion HTTP/2 qui en multiplexe davantage : 8 à la fois.
      const queue = [...this.shared.coldAssets];
      await Promise.all(Array.from({ length: 8 }, async () => {
        for (let path = queue.shift(); path; path = queue.shift()) await this.http('statique.ressource', path);
      }));
      this.record('ux.chargement-a-froid', t0, true);
    }
    const t1 = performance.now();
    try {
      await this.aw('aw.account.get', () => this.account.get());
      await Promise.all([
        this.aw('aw.account.get', () => this.account.get()),
        this.aw('aw.account.jwt', () => this.account.createJWT()).then((jwt) => {
          this.jwt = jwt.jwt;
          return this.apiCall('api.billing.overview', '/api/billing/overview', { headers: { Authorization: `Bearer ${jwt.jwt}` } });
        }),
        this.aw('aw.projects.list', () => this.databases.listDocuments(DATABASE_ID, 'projects', [
          Query.equal('user_id', this.spec.session.userId),
          Query.orderDesc('$updatedAt'),
          Query.select(PROJECT_META_FIELDS),
          Query.limit(100),
        ])),
        this.aw('aw.folders.list', () => this.databases.listDocuments(DATABASE_ID, 'project_folders', [
          Query.equal('user_id', this.spec.session.userId),
          Query.limit(100),
        ])),
        this.aw('aw.teams.list', () => this.teams.list([Query.limit(100)])).then(async (teams) => {
          const ids = teams.teams.map((team) => team.$id).filter((id) => id.startsWith('p'));
          if (ids.length === 0) return;
          await this.aw('aw.projects.list-partages', () => this.databases.listDocuments(DATABASE_ID, 'projects', [
            Query.equal('team_id', ids),
            Query.notEqual('user_id', this.spec.session.userId),
            Query.orderDesc('$updatedAt'),
            Query.select(PROJECT_META_FIELDS),
            Query.limit(100),
          ]));
        }),
        this.http('temps-reel.sante', '/multiplayer/health'),
      ]);
      this.record('ux.tableau-de-bord', t1, true);
    } catch (error) {
      this.record('ux.tableau-de-bord', t1, false, errorWhy(error));
    }
  }

  // ── Projet personnel ─────────────────────────────────────────────────────

  private get project(): OwnProject {
    return this.spec.own[this.projectIndex % this.spec.own.length]!;
  }

  private get payload(): FixturePayload {
    return this.shared.payloads[this.project.size];
  }

  async openProject(projectId: string, name = 'ux.ouverture-projet'): Promise<boolean> {
    const t0 = performance.now();
    try {
      const viewId = projectViewDocumentId(projectId, this.spec.session.userId);
      await Promise.all([
        this.aw('aw.projects.get', () => this.databases.getDocument(DATABASE_ID, 'projects', projectId)),
        this.aw('aw.views.get', () => this.databases.getDocument(DATABASE_ID, 'project_views', viewId), { expect404: true }).then(
          () => {
            this.viewCreated = true;
          },
          async (error) => {
            if (!(error instanceof AppwriteException) || error.code !== 404) throw error;
            await this.aw('aw.views.list', () => this.databases.listDocuments(DATABASE_ID, 'project_views', [
              Query.equal('project_id', projectId),
              Query.equal('user_id', this.spec.session.userId),
              Query.limit(10),
            ]));
          },
        ),
        this.aw('aw.thumbnails.list', () => this.storage.listFiles('project-thumbnails', [Query.equal('$id', [projectId]), Query.limit(1)])),
      ]);
      this.record(name, t0, true);
      return true;
    } catch (error) {
      this.record(name, t0, false, errorWhy(error));
      return false;
    }
  }

  /** Sauvegarde automatique : contrôle de version puis écriture du document (saveProject). */
  async save(name = 'ux.sauvegarde'): Promise<void> {
    const t0 = performance.now();
    const projectId = this.project.id;
    try {
      await this.aw('aw.projects.get-version', () => this.databases.getDocument(DATABASE_ID, 'projects', projectId, [Query.select(['$id', '$updatedAt'])]));
      await this.aw('aw.projects.update', () => this.databases.updateDocument(DATABASE_ID, 'projects', projectId, {
        name: `${OWN_NAME_PREFIX}${this.projectIndex % this.spec.own.length + 1} (${this.project.size})`,
        data: this.payload.data,
        size_bytes: this.payload.sizeBytes,
        privacy: 'private',
      }));
      this.record(name, t0, true);
    } catch (error) {
      this.record(name, t0, false, errorWhy(error));
    }
  }

  /** Vue de l'utilisateur (mode, caméra…) : PATCH, ou création au premier passage. */
  async saveView(projectId: string): Promise<void> {
    const viewId = projectViewDocumentId(projectId, this.spec.session.userId);
    const data = viewData(this.random, this.spec.room?.itineraryId ?? 'it');
    try {
      if (this.viewCreated) {
        await this.aw('aw.views.update', () => this.databases.updateDocument(DATABASE_ID, 'project_views', viewId, { data }));
        return;
      }
      await this.aw('aw.views.create', () => this.databases.createDocument(DATABASE_ID, 'project_views', viewId, {
        project_id: projectId,
        user_id: this.spec.session.userId,
        data,
      }, [
        Permission.read(Role.user(this.spec.session.userId)),
        Permission.update(Role.user(this.spec.session.userId)),
        Permission.delete(Role.user(this.spec.session.userId)),
      ]));
      this.viewCreated = true;
    } catch (error) {
      if (error instanceof AppwriteException && error.code === 409) this.viewCreated = true;
    }
  }

  // ── Tracé ────────────────────────────────────────────────────────────────

  /**
   * Déplacement d'un point de passage : le vrai pipeline route le nouveau
   * tracé (cache du proxy évité : le point bouge), puis la météo du tracé.
   * Renvoie le tracé, ou null (échec, budget d'IP épuisé).
   */
  async trace(name = 'ux.trace'): Promise<number[][] | null> {
    const beeline = haversineM(this.route.start, this.route.end) / 1000;
    // Requêtes probables : un envoi de profil (le premier) + 1 tracé, 3 au-delà de ~180 km (ancres).
    const expected = beeline * 1.3 > 180 ? 4 : 2;
    if (!this.shared.apiBudget.reserve(expected)) {
      this.shared.record({ name, ms: 0, ok: false, at: Date.now(), why: 'budget-ip' });
      return null;
    }
    if (this.random.chance(0.5)) this.route = { ...this.route, end: jitterPoint(this.random, this.route.end, 1_500) };
    else this.route = { ...this.route, start: jitterPoint(this.random, this.route.start, 1_500) };
    const net: VuNet = { vu: this.id, calls: 0, statuses: [] };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 120_000);
    const t0 = performance.now();
    try {
      const result = await vuNet.run(net, () => this.shared.routing.resolveRouteRequest({
        itinerary: this.itinerary,
        signal: controller.signal,
        requestBase: { start: this.route.start, end: this.route.end, via: [], signal: controller.signal },
        setRouteWarnings: () => {},
      }));
      if (net.calls > expected) this.shared.apiBudget.consume(net.calls - expected);
      const ms = this.record(name, t0, true);
      // Requêtes réellement faites pour ce tracé (doublages, nouveaux essais après un calcul tué, ancres).
      this.shared.record({ name: `${name}.requetes`, ms: net.calls, ok: true, at: Date.now() });
      const rejected = net.statuses.filter((status) => status === 422).length;
      if (rejected) this.shared.record({ name: `${name}.reponses-422`, ms: rejected, ok: true, at: Date.now() });
      const km = beeline < 100 ? '<100' : beeline < 200 ? '100-200' : beeline < 500 ? '200-500' : '>500';
      this.shared.record({ name: `${name}.${km}km`, ms, ok: true, at: Date.now() });
      return result.route.coordinates;
    } catch (error) {
      if (net.calls > expected) this.shared.apiBudget.consume(net.calls - expected);
      const failed = net.statuses.find((status) => status >= 400);
      this.record(name, t0, false, failed === 429 ? 'budget-ip' : failed ? `http ${failed}` : errorWhy(error));
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Météo du tracé (`fetchRouteWeatherDataset`) : une requête, stations le long du tracé. */
  async routeWeather(coordinates: number[][]): Promise<void> {
    if (coordinates.length < 2) return;
    const cumulative = [0];
    for (let index = 1; index < coordinates.length; index += 1) {
      const [lonA, latA] = coordinates[index - 1]!;
      const [lonB, latB] = coordinates[index]!;
      cumulative.push(cumulative[index - 1]! + haversineM({ lat: latA!, lon: lonA! }, { lat: latB!, lon: lonB! }));
    }
    const total = cumulative[cumulative.length - 1]!;
    const count = weatherStationCount(total);
    const lats: string[] = [];
    const lons: string[] = [];
    let cursor = 0;
    for (let station = 0; station < count; station += 1) {
      const target = (total * station) / Math.max(1, count - 1);
      while (cursor < cumulative.length - 1 && cumulative[cursor]! < target) cursor += 1;
      lats.push(coordinates[cursor]![1]!.toFixed(4));
      lons.push(coordinates[cursor]![0]!.toFixed(4));
    }
    const day = new Date().toISOString().slice(0, 10);
    const endDay = new Date(Date.now() + Math.ceil(total / 1000 / 20 / 24) * 86_400_000).toISOString().slice(0, 10);
    await this.apiCall('api.meteo-trace', `/api/openmeteo/v1/forecast?latitude=${lats.join(',')}&longitude=${lons.join(',')}`
      + '&hourly=temperature_2m,apparent_temperature,precipitation,wind_speed_10m,cloud_cover,relative_humidity_2m,sunshine_duration'
      + `&start_date=${day}&end_date=${endDay}`
      + '&timezone=auto&temperature_unit=celsius&precipitation_unit=mm&wind_speed_unit=kmh&cell_selection=nearest&models=meteofrance_seamless', {
      headers: { Accept: 'application/json' },
    });
  }

  // ── Session réaliste ─────────────────────────────────────────────────────

  /**
   * Une visite : arrivée (à froid une fois sur `coldShare`), tableau de bord,
   * ouverture du projet (ou de la salle partagée), puis une session d'édition
   * de durée exponentielle (moyenne 3 min) faite de gestes espacés de 8 à 30 s.
   */
  async visit(until: number): Promise<void> {
    await this.arrive(this.random.chance(this.shared.coldShare));
    if (Date.now() >= until || this.stopped) return;
    if (this.spec.room) {
      await this.collabVisit(until);
      return;
    }
    this.projectIndex = this.random.chance(0.8) ? 0 : 1 + Math.floor(this.random.next() * (this.spec.own.length - 1));
    this.viewCreated = false;
    if (!(await this.openProject(this.project.id))) return;
    const editUntil = Math.min(until, Date.now() + this.random.exponential(180_000, 60_000, 480_000));
    while (Date.now() < editUntil && !this.stopped) {
      await sleep(this.random.between(8_000, 30_000));
      if (Date.now() >= editUntil || this.stopped) break;
      const gesture = this.random.weighted([['trace', 45], ['reglage', 35], ['vue', 20]] as const);
      if (gesture === 'trace') {
        const coordinates = await this.trace();
        if (coordinates) await this.routeWeather(coordinates);
        // Le tracé, puis les résultats dérivés (allure, profils) : 1 à 3 sauvegardes espacées de ~4 s.
        const saves = 1 + Math.floor(this.random.next() * 3);
        for (let index = 0; index < saves && !this.stopped; index += 1) {
          await this.save();
          if (index < saves - 1) await sleep(4_000);
        }
        await this.saveView(this.project.id);
      } else if (gesture === 'reglage') {
        await this.save();
      } else {
        await this.saveView(this.project.id);
      }
    }
  }

  /** Avant une rafale : un co-éditeur sans connexion ouverte la rouvre (hors mesure de la rafale). */
  async prepareBurst(): Promise<void> {
    if (!this.spec.room || this.socket?.ready) return;
    if (!(await this.openProject(this.spec.room.projectId, 'ux.ouverture-projet-partage'))) return;
    this.socket = new CollabSocket(this.shared, this.spec.room, this.id);
    const jwt = this.jwt ?? (await this.aw('aw.account.jwt', () => this.account.createJWT())).jwt;
    this.jwt = jwt;
    await this.socket.open(jwt);
  }

  /** Rafale : le même geste lourd pour tous au même instant (ouverture, tracé, sauvegarde). */
  async burst(): Promise<void> {
    if (this.spec.room && this.socket?.ready) {
      await this.socket.routeEdit(this, 'rafale.co-edition-trace');
      return;
    }
    this.projectIndex = 0;
    await this.openProject(this.project.id, 'rafale.ouverture-projet');
    const coordinates = await this.trace('rafale.trace');
    if (coordinates) await this.routeWeather(coordinates);
    await this.save('rafale.sauvegarde');
  }

  // ── Co-édition ───────────────────────────────────────────────────────────

  private async collabVisit(until: number): Promise<void> {
    const room = this.spec.room!;
    if (!(await this.openProject(room.projectId, 'ux.ouverture-projet-partage'))) return;
    if (!this.socket || this.socket.closed) {
      this.socket = new CollabSocket(this.shared, room, this.id);
      const jwt = this.jwt ?? (await this.aw('aw.account.jwt', () => this.account.createJWT())).jwt;
      this.jwt = jwt;
      await this.socket.open(jwt);
    }
    if (!this.socket.ready) return;
    const editUntil = until;
    while (Date.now() < editUntil && !this.stopped && this.socket.ready) {
      await sleep(this.random.between(6_000, 20_000));
      if (Date.now() >= editUntil || this.stopped) break;
      const gesture = this.random.weighted([['trace', 35], ['reglage', 45], ['vue', 20]] as const);
      if (gesture === 'trace') await this.socket.routeEdit(this, 'ux.co-edition-trace');
      else if (gesture === 'reglage') this.socket.smallEdit(this.random);
      else await this.saveView(room.projectId);
      // Pointeur en direct à 20 Hz pendant ~30 % du temps actif.
      if (this.random.chance(0.3)) this.socket.movePointer(this.random.between(3_000, 10_000));
    }
  }

  /** Tracé pour la co-édition (le pipeline route ; le résultat part en lot). */
  async traceForCollab(name: string): Promise<number[][] | null> {
    return this.trace(name);
  }

  closeCollab(): void {
    this.socket?.close();
    this.socket = null;
  }
}

const OWN_NAME_PREFIX = 'Charge · projet ';

/**
 * Connexion temps réel d'un utilisateur virtuel. Les mesures de diffusion
 * (lot d'un autre → reçu ici) ne valent que parce qu'une salle entière vit
 * dans un même processus (même horloge, `shared.sentAt`).
 */
class CollabSocket {
  private socket: WebSocket | null = null;
  private store: ObjectStore | null = null;
  private clientSeq = 0;
  private compress = false;
  private readonly clientId: string;
  private readonly pending = new Map<number, (ok: boolean) => void>();
  private pointerTimer: ReturnType<typeof setInterval> | null = null;
  private pointerStop = 0;
  ready = false;
  closed = false;

  private readonly shared: VuShared;
  private readonly room: Room;

  constructor(shared: VuShared, room: Room, vu: string) {
    this.shared = shared;
    this.room = room;
    this.clientId = `${vu}-${Math.random().toString(36).slice(2, 8)}`;
  }

  async open(jwt: string): Promise<void> {
    const t0 = performance.now();
    const url = `${this.shared.appUrl.replace(/^http/, 'ws')}/multiplayer?project=${encodeURIComponent(this.room.projectId)}`;
    await new Promise<void>((resolve) => {
      const socket = new WebSocket(url, socketProtocols(jwt), {
        headers: { Origin: this.shared.appUrl },
        perMessageDeflate: false,
        handshakeTimeout: REQUEST_TIMEOUT_MS,
      });
      this.socket = socket;
      const fail = (why: string) => {
        if (this.ready) return;
        this.closed = true;
        this.shared.record({ name: 'collab.connexion', ms: Math.round(performance.now() - t0), ok: false, at: Date.now(), why });
        resolve();
      };
      const deadline = setTimeout(() => {
        fail('délai welcome');
        socket.terminate();
      }, 20_000);
      socket.on('open', () => socket.send(JSON.stringify({
        type: 'hello', v: PROTOCOL_VERSION, clientId: this.clientId, epoch: null, lastSeq: null, compress: true,
      })));
      socket.on('unexpected-response', (_req, res) => {
        clearTimeout(deadline);
        fail(`http ${res.statusCode}`);
      });
      socket.on('error', (error) => {
        clearTimeout(deadline);
        fail(errorWhy(error));
      });
      socket.on('close', (code) => {
        clearTimeout(deadline);
        if (!this.ready) fail(`fermé ${code}`);
        else if (!this.closed) this.shared.record({ name: 'collab.coupure', ms: 0, ok: false, at: Date.now(), why: `fermé ${code}` });
        this.ready = false;
        this.closed = true;
        for (const settle of this.pending.values()) settle(false);
        this.pending.clear();
      });
      socket.on('message', (data, isBinary) => {
        const receivedAt = performance.now();
        wsTraffic.down += (data as Buffer).length ?? 0;
        let message: ServerMessage;
        try {
          message = JSON.parse(isBinary ? inflateRawSync(data as Buffer).toString('utf8') : String(data)) as ServerMessage;
        } catch {
          return;
        }
        if (message.type === 'welcome') {
          clearTimeout(deadline);
          this.compress = message.compress === true;
          this.clientSeq = message.clientSeq;
          if (message.snapshot) this.store = deserializeStore(message.snapshot);
          for (const batch of message.catchUp ?? []) this.applyBatch(batch.ops, batch.blobs);
          this.ready = this.store !== null;
          this.shared.record({ name: 'collab.connexion', ms: Math.round(receivedAt - t0), ok: this.ready, at: Date.now(), ...(this.ready ? {} : { why: 'sans état' }) });
          resolve();
        } else if (message.type === 'batch') {
          const { batch } = message;
          this.applyBatch(batch.ops, batch.blobs);
          const key = `${batch.clientId}#${batch.clientSeq}`;
          const sentAt = this.shared.sentAt.get(key);
          if (batch.clientId === this.clientId) {
            this.pending.get(batch.clientSeq)?.(true);
            this.pending.delete(batch.clientSeq);
            if (sentAt !== undefined) this.shared.record({ name: 'collab.accuse', ms: Math.round(receivedAt - sentAt), ok: true, at: Date.now() });
          } else if (sentAt !== undefined) {
            // Lot de tracé (morceaux de route) et petit lot (réglage) n'ont pas le même coût.
            const name = Object.keys(batch.blobs ?? {}).length > 0 ? 'collab.diffusion-trace' : 'collab.diffusion';
            this.shared.record({ name, ms: Math.round(receivedAt - sentAt), ok: true, at: Date.now() });
          }
        } else if (message.type === 'reject') {
          this.shared.record({ name: 'collab.refus', ms: 0, ok: false, at: Date.now(), why: message.reason.slice(0, 40) });
          this.pending.get(message.clientSeq)?.(false);
          this.pending.delete(message.clientSeq);
        } else if (message.type === 'motion') {
          const latency = receivedAt - message.t;
          if (latency >= 0 && latency < 60_000) this.shared.record({ name: 'collab.pointeur', ms: Math.round(latency), ok: true, at: Date.now() });
        } else if (message.type === 'error') {
          this.shared.record({ name: 'collab.erreur', ms: 0, ok: false, at: Date.now(), why: message.code });
        }
      });
    });
  }

  private applyBatch(ops: any[], blobs: Record<string, string>): void {
    if (!this.store) return;
    for (const [id, json] of Object.entries(blobs ?? {})) this.store.putBlob(id, json);
    applyOps(this.store, ops);
  }

  private send(payload: Record<string, unknown>): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    const json = JSON.stringify(payload);
    if (this.compress && json.length >= WIRE_COMPRESS_MIN_CHARS) {
      const frame = deflateRawSync(json, { level: 6 });
      wsTraffic.up += frame.length;
      this.socket.send(frame, { binary: true });
    } else {
      wsTraffic.up += Buffer.byteLength(json);
      this.socket.send(json);
    }
  }

  /** Envoie un lot ; résout à son accusé (le lot revient du serveur), faux sur refus / coupure / 30 s. */
  private sendBatch(ops: any[], blobs: Record<string, string>): Promise<boolean> {
    this.clientSeq += 1;
    const clientSeq = this.clientSeq;
    this.shared.sentAt.set(`${this.clientId}#${clientSeq}`, performance.now());
    const done = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(clientSeq);
        resolve(false);
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(clientSeq, (ok) => {
        clearTimeout(timer);
        resolve(ok);
      });
    });
    this.send({ type: 'batch', clientSeq, ops, blobs });
    return done;
  }

  /** Réglage (nom, couleur, priorité) : un lot d'une opération, comme un geste dans le panneau. */
  smallEdit(random: Random): void {
    if (!this.ready) return;
    const id = `p/itineraries:${this.room.itineraryId}`;
    const choice = random.pick(['name', 'color', 'priorities.elevation'] as const);
    const value = choice === 'name' ? `Itinéraire ${Math.floor(random.next() * 1000)}`
      : choice === 'color' ? `#${Math.floor(random.next() * 0xffffff).toString(16).padStart(6, '0')}`
        : Math.floor(random.next() * 100);
    void this.sendBatch([{ t: 's', id, k: choice, v: value }], {});
  }

  /**
   * Nouveau tracé dans la salle : bail demandé, tracé par le pipeline de l'app
   * (pour la charge BRouter), puis le document matérialisé depuis l'état de
   * la salle avec la route modifiée à partir d'un point (distances décalées en
   * aval, comme un déplacement de point de passage) → `diffDocument` → lot.
   */
  async routeEdit(user: VirtualUser, name: string): Promise<void> {
    if (!this.ready || !this.store) return;
    const t0 = performance.now();
    this.send({ type: 'lease', action: 'request', kind: 'route', itineraryId: this.room.itineraryId });
    await user.traceForCollab(`${name}.routage`);
    if (!this.ready || !this.store) return;
    const materializer = new Materializer();
    const prev = materializer.materialize(this.store) as any;
    const itineraries = prev.itineraries as any[];
    const index = itineraries.findIndex((itinerary) => itinerary.id === this.room.itineraryId);
    const points = itineraries[index]?.gpxRoute?.points as Array<Record<string, number>> | undefined;
    if (index < 0 || !points || points.length < 10) return;
    const from = Math.floor(points.length * (0.3 + Math.random() * 0.6));
    const shiftM = (Math.random() - 0.5) * 400;
    const nextPoints = points.map((point, i) => (i < from ? point : {
      ...point,
      lat: i < from + 40 ? point.lat! + (Math.random() - 0.5) * 2e-4 : point.lat!,
      distanceM: point.distanceM! + shiftM,
    }));
    const next = {
      ...prev,
      itineraries: itineraries.map((itinerary, i) => (i !== index ? itinerary : { ...itinerary, gpxRoute: { ...itinerary.gpxRoute, points: nextPoints, routedInputsKey: `charge-${Date.now()}` } })),
    };
    const changes = diffDocument(this.store, prev, next);
    const ok = await this.sendBatch(changes.ops, Object.fromEntries(changes.blobs));
    this.send({ type: 'lease', action: 'release', kind: 'route', itineraryId: this.room.itineraryId });
    this.shared.record({ name, ms: Math.round(performance.now() - t0), ok, at: Date.now(), ...(ok ? {} : { why: 'lot non accusé' }) });
  }

  /** Pointeur sur la carte à 20 Hz pendant `durationMs` (présence en direct). */
  movePointer(durationMs: number): void {
    this.pointerStop = Date.now() + durationMs;
    if (this.pointerTimer) return;
    let step = 0;
    this.pointerTimer = setInterval(() => {
      if (!this.ready || Date.now() > this.pointerStop) {
        if (this.pointerTimer) clearInterval(this.pointerTimer);
        this.pointerTimer = null;
        return;
      }
      step += 1;
      const x = (step % 400) / 400;
      this.send({
        type: 'motion',
        t: Math.round(performance.now() * 10) / 10,
        cam: [6.1 + 0.05 * x, 45.9, 12, 0, 50, 36.87],
        vp: [1600, 900, 64, 360, 300, 420, 0, 0, 0, 0],
        ptr: [6.1 + 0.02 * x, 45.9 + 0.01 * x],
      });
    }, 50);
  }

  close(): void {
    if (this.pointerTimer) clearInterval(this.pointerTimer);
    this.pointerTimer = null;
    this.ready = false;
    this.closed = true;
    this.socket?.close(1000, 'fin');
  }
}


/**
 * Rapport du banc de charge du VPS : par palier (nombre d'utilisateurs) et
 * phase (réaliste, rafale), latences p50 / p95 des gestes de l'utilisateur et
 * des requêtes, erreurs, et l'état du VPS sur la même fenêtre ; puis le
 * palier où l'expérience se dégrade (premier seuil franchi, ou p95 qui
 * double par rapport au palier de référence à 1 utilisateur).
 */
import type { Sample, Summary } from './lib.ts';
import { summarize } from './lib.ts';
import type { VpsWindow } from './sampler.ts';

/**
 * Seuils d'expérience (p95, ms) : au-delà, un utilisateur le ressent. Ordres
 * de grandeur usuels (RAIL : réponse < 1 s pour une action qui charge des
 * données ; < 100 ms pour la présence en direct, qui doit sembler instantanée),
 * adaptés à RedView (un tracé long reste un calcul de plusieurs secondes).
 */
export const UX_SLO: Record<string, { p95: number; label: string }> = {
  'statique.page': { p95: 500, label: 'Page de l\'app (HTML)' },
  'ux.chargement-a-froid': { p95: 6_000, label: 'Premier chargement (toutes les ressources)' },
  'ux.tableau-de-bord': { p95: 1_500, label: 'Tableau de bord prêt' },
  'ux.ouverture-projet': { p95: 2_000, label: 'Ouverture d\'un projet' },
  'ux.ouverture-projet-partage': { p95: 2_000, label: 'Ouverture d\'un projet partagé' },
  'ux.sauvegarde': { p95: 2_000, label: 'Sauvegarde automatique' },
  'ux.trace.<100km': { p95: 3_000, label: 'Tracé < 100 km' },
  'ux.trace.100-200km': { p95: 6_000, label: 'Tracé 100–200 km' },
  'ux.trace.200-500km': { p95: 15_000, label: 'Tracé 200–500 km' },
  'api.meteo-trace': { p95: 1_500, label: 'Météo du tracé' },
  'collab.connexion': { p95: 2_000, label: 'Entrée dans une salle (welcome)' },
  'collab.diffusion': { p95: 250, label: 'Modification vue par les autres' },
  'collab.diffusion-trace': { p95: 1_500, label: 'Nouveau tracé vu par les autres (lot de route)' },
  'collab.accuse': { p95: 500, label: 'Modification confirmée' },
  'collab.pointeur': { p95: 150, label: 'Pointeur en direct' },
  'ux.co-edition-trace': { p95: 8_000, label: 'Nouveau tracé partagé (routage + lot)' },
  'rafale.ouverture-projet': { p95: 3_000, label: 'Rafale : ouverture' },
  'rafale.trace': { p95: 8_000, label: 'Rafale : tracé' },
  'rafale.sauvegarde': { p95: 3_000, label: 'Rafale : sauvegarde' },
  'rafale.co-edition-trace': { p95: 10_000, label: 'Rafale : tracé partagé' },
};
/** Erreurs tolérées (hors budget d'API de l'IP du générateur, qui n'est pas une erreur du VPS). */
export const MAX_ERROR_RATE = 0.01;

/** Santé du générateur sur la phase (somme ou pire des processus de travail). */
export interface GeneratorHealth {
  loopP99Ms: number;
  loopMaxMs: number;
  cpuCores: number;
  upMbps: number;
  downMbps: number;
}

/** Durées vues par le serveur de l'app (journaux pino : `responseTime` par route). */
export type ServerRoutes = Record<string, { n: number; p50: number; p95: number; statuses: Record<string, number> }>;

export interface PhaseResult {
  step: number;
  phase: 'realiste' | 'rafale';
  startedAt: number;
  endedAt: number;
  aborted?: string;
  actions: Record<string, Summary>;
  vps: VpsWindow | null;
  apiSkipped: number;
  generator?: GeneratorHealth;
  server?: ServerRoutes;
}

export function buildPhaseResult(
  step: number,
  phase: PhaseResult['phase'],
  startedAt: number,
  endedAt: number,
  samples: Sample[],
  vps: VpsWindow | null,
  extra: { aborted?: string; generator?: GeneratorHealth; server?: ServerRoutes } = {},
): PhaseResult {
  const { aborted, generator, server } = extra;
  const byName = new Map<string, Sample[]>();
  for (const sample of samples) {
    if (sample.why === 'budget-ip') continue;
    const list = byName.get(sample.name) ?? [];
    list.push(sample);
    byName.set(sample.name, list);
  }
  const actions: Record<string, Summary> = {};
  for (const [name, list] of [...byName].sort((a, b) => a[0].localeCompare(b[0]))) actions[name] = summarize(list);
  return {
    step,
    phase,
    startedAt,
    endedAt,
    ...(aborted ? { aborted } : {}),
    actions,
    vps,
    apiSkipped: samples.filter((sample) => sample.why === 'budget-ip').length,
    ...(generator ? { generator } : {}),
    ...(server ? { server } : {}),
  };
}

export interface Verdict {
  name: string;
  label: string;
  p95: number;
  slo: number;
  baseline: number | null;
  reason: 'seuil' | 'x2' | 'erreurs';
  errorRate: number;
}

/** Ce qui se dégrade à ce palier : seuil franchi, p95 doublé vs référence, ou erreurs > 1 %. */
export function verdicts(result: PhaseResult, baseline: PhaseResult | null): Verdict[] {
  const out: Verdict[] = [];
  for (const [name, summary] of Object.entries(result.actions)) {
    const slo = UX_SLO[name];
    const errorRate = summary.n ? summary.errors / summary.n : 0;
    const base = baseline?.actions[name]?.p95 ?? null;
    if (summary.n >= 3 && errorRate > MAX_ERROR_RATE && (slo || name.startsWith('aw.') || name.startsWith('api.'))) {
      out.push({ name, label: slo?.label ?? name, p95: summary.p95, slo: slo?.p95 ?? Number.NaN, baseline: base, reason: 'erreurs', errorRate });
      continue;
    }
    if (!slo || summary.ok < 3) continue;
    if (summary.p95 > slo.p95) out.push({ name, label: slo.label, p95: summary.p95, slo: slo.p95, baseline: base, reason: 'seuil', errorRate });
    else if (base !== null && base > 50 && (baseline?.actions[name]?.ok ?? 0) >= 5 && summary.p95 > 2 * base) out.push({ name, label: slo.label, p95: summary.p95, slo: slo.p95, baseline: base, reason: 'x2', errorRate });
  }
  return out;
}

/** Processus suivis dans le tableau du VPS (conteneurs et services systemd). */
const WATCHED: Array<[string, string]> = [
  ['svc:brouter', 'BRouter'],
  ['app', 'app'],
  ['temps-reel', 'temps réel'],
  ['appwrite', 'Appwrite'],
  ['aw-mariadb', 'MariaDB'],
  ['aw-redis', 'Redis'],
  ['aw-traefik', 'Traefik'],
  ['svc:nginx', 'nginx'],
  ['aw-clickhouse-1', 'ClickHouse'],
  ['open-meteo', 'Open-Meteo'],
];

const fmt = (value: number | null | undefined, digits = 0) => (value == null || !Number.isFinite(value) ? '—' : value.toFixed(digits));
const ms = (value: number) => (!Number.isFinite(value) ? '—' : value >= 10_000 ? `${(value / 1000).toFixed(1)} s` : `${Math.round(value)}`);
/** Durée avec son unité, pour le texte (les tableaux sont en ms). */
const duration = (value: number) => (!Number.isFinite(value) ? '—' : value >= 10_000 ? `${(value / 1000).toFixed(1)} s` : `${Math.round(value)} ms`);

export interface RunMeta {
  link: { downMbps: number; upMbps: number; rttMs: number } | null;
  label: string;
  waves: number;
  startedAt: string;
  appUrl: string;
  steps: number[];
  holdS: number;
  apiPerMinute: number;
  payloadVariant: string;
  power: string;
  gitHead: string;
  notes: string[];
}

export function renderMarkdown(meta: RunMeta, results: PhaseResult[], idle: VpsWindow | null): string {
  const lines: string[] = [];
  const baseline = results.find((result) => result.phase === 'realiste' && result.step === Math.min(...meta.steps)) ?? null;
  lines.push(`# Banc de charge du VPS — ${meta.label}`, '');
  lines.push(`${meta.startedAt} · ${meta.appUrl} · commit ${meta.gitHead} · alimentation : ${meta.power} · charges de projet : ${meta.payloadVariant}`, '');
  lines.push(`Paliers ${meta.steps.join(' → ')} utilisateurs, ${meta.holdS} s de session réaliste chacun puis ${meta.waves} vague(s) de rafale. Budget d'API du générateur : ${Number.isFinite(meta.apiPerMinute) ? `${meta.apiPerMinute} requêtes/min (limite par IP de server.mjs : le reste est sauté, compté à part)` : 'aucun (jeton de banc)'}.`, '');
  if (meta.link) lines.push(`Lien du générateur mesuré avant la passe : ↓ ${fmt(meta.link.downMbps)} Mbit/s, ↑ ${fmt(meta.link.upMbps)} Mbit/s, aller-retour ${fmt(meta.link.rttMs)} ms. Au-delà de ~70 % de ces débits pendant une phase, les latences mesurées incluent la file d'attente du lien du portable.`, '');
  for (const note of meta.notes) lines.push(`- ${note}`);
  if (meta.notes.length) lines.push('');

  // Verdict global.
  lines.push('## Où l\'expérience se dégrade', '');
  let knee: number | null = null;
  for (const result of results) {
    const found = verdicts(result, result.phase === 'realiste' ? baseline : null);
    if (found.length && knee === null && result.phase === 'realiste') knee = result.step;
    if (!found.length) continue;
    lines.push(`- **${result.step} utilisateurs, ${result.phase}** : ${found.map((v) => `${v.label} ${v.reason === 'erreurs' ? `${(v.errorRate * 100).toFixed(1)} % d'erreurs` : `p95 ${duration(v.p95)}${v.reason === 'x2' ? ` (×${(v.p95 / (v.baseline ?? 1)).toFixed(1)} vs 1 utilisateur)` : ` > ${duration(v.slo)}`}`}`).join(' ; ')}`);
  }
  lines.push('', knee === null ? 'Aucun seuil franchi en session réaliste sur les paliers joués.' : `Premier palier dégradé en session réaliste : **${knee} utilisateurs**.`, '');

  // Tableau UX par palier.
  const uxNames = Object.keys(UX_SLO).filter((name) => results.some((result) => result.actions[name]));
  for (const phase of ['realiste', 'rafale'] as const) {
    const phaseResults = results.filter((result) => result.phase === phase);
    if (!phaseResults.length) continue;
    lines.push(`## Gestes de l'utilisateur — ${phase === 'realiste' ? 'session réaliste' : 'rafale'} (p50 / p95 ms, erreurs)`, '');
    lines.push(`| Geste | seuil p95 | ${phaseResults.map((result) => `${result.step} u.`).join(' | ')} |`);
    lines.push(`|---|---|${phaseResults.map(() => '---').join('|')}|`);
    for (const name of uxNames) {
      if (!phaseResults.some((result) => result.actions[name])) continue;
      const cells = phaseResults.map((result) => {
        const s = result.actions[name];
        if (!s) return '—';
        const err = s.errors ? ` ⚠ ${s.errors}/${s.n}` : '';
        const flag = s.p95 > (UX_SLO[name]?.p95 ?? Infinity) ? ' 🔴' : '';
        return `${ms(s.p50)} / ${ms(s.p95)}${flag}${err}`;
      });
      lines.push(`| ${UX_SLO[name]!.label} | ${ms(UX_SLO[name]!.p95)} | ${cells.join(' | ')} |`);
    }
    lines.push('');
  }

  // Requêtes élémentaires.
  lines.push('## Requêtes élémentaires — session réaliste (p50 / p95 ms, n, erreurs)', '');
  const realistic = results.filter((result) => result.phase === 'realiste');
  const names = [...new Set(realistic.flatMap((result) => Object.keys(result.actions)))].filter((name) => !UX_SLO[name]).sort();
  lines.push(`| Requête | ${realistic.map((result) => `${result.step} u.`).join(' | ')} |`);
  lines.push(`|---|${realistic.map(() => '---').join('|')}|`);
  for (const name of names) {
    const cells = realistic.map((result) => {
      const s = result.actions[name];
      if (!s) return '—';
      const failures = Object.entries(s.failures).map(([why, count]) => `${why}×${count}`).join(' ');
      return `${ms(s.p50)} / ${ms(s.p95)} (${s.n})${failures ? ` ⚠ ${failures}` : ''}`;
    });
    lines.push(`| ${name} | ${cells.join(' | ')} |`);
  }
  lines.push('');

  // VPS.
  lines.push('## VPS sur la même fenêtre', '');
  const all = [...(idle ? [{ label: 'repos', vps: idle }] : []), ...results.map((r) => ({ label: `${r.step} u. ${r.phase}`, vps: r.vps }))];
  const cores = (vps: VpsWindow, name: string) => {
    const entry = vps.processes[name];
    return entry ? `${fmt(entry.cores, 2)} / ${fmt(entry.coresMax, 2)}` : '—';
  };
  lines.push(`| Fenêtre | CPU hôte moy / max % | iowait % | charge max | RAM dispo min | swap Δ | ${WATCHED.map(([, label]) => label).join(' | ')} |`);
  lines.push(`|---|---|---|---|---|---|${WATCHED.map(() => '---').join('|')}|`);
  for (const { label, vps } of all) {
    if (!vps) {
      lines.push(`| ${label} | — |${' |'.repeat(4 + WATCHED.length)}`);
      continue;
    }
    lines.push(`| ${label} | ${fmt(vps.cpuAvg)} / ${fmt(vps.cpuMax)} | ${fmt(vps.iowaitAvg, 1)} | ${fmt(vps.load1Max, 2)} | ${fmt(vps.memAvailMinMb / 1024, 1)} Go | ${fmt(vps.swapUsedDeltaMb)} Mo | ${WATCHED.map(([name]) => cores(vps, name)).join(' | ')} |`);
  }
  lines.push('', 'CPU en cœurs (moyenne / pic sur 2 s), cgroups v2. Les 5 plus gros consommateurs par fenêtre :', '');
  for (const { label, vps } of all) {
    if (!vps) continue;
    const top = Object.entries(vps.processes).slice(0, 6).map(([name, entry]) => `${name} ${fmt(entry.cores, 2)}`).join(', ');
    lines.push(`- ${label} : ${top}`);
  }
  lines.push('');
  const mp = results.filter((r) => r.vps?.multiplayer).map((r) => ({ label: `${r.step} u. ${r.phase}`, mp: r.vps!.multiplayer! }));
  if (mp.length) {
    lines.push('### Serveur temps réel (mesures internes en fin de fenêtre)', '');
    lines.push('| Fenêtre | salles | clients | journal p95 | point de reprise p95 | boucle p99 / max | RSS | refus | erreurs journal |');
    lines.push('|---|---|---|---|---|---|---|---|---|');
    for (const { label, mp: m } of mp) {
      lines.push(`| ${label} | ${m.rooms ?? '—'} | ${m.clients ?? '—'} | ${m.journal_latency_p95_ms ?? '—'} ms | ${m.checkpoint_p95_ms ?? '—'} ms | ${m.event_loop_delay_p99_ms ?? '—'} / ${m.event_loop_delay_max_ms ?? '—'} ms | ${fmt((m.rss_bytes ?? 0) / 1048576)} Mo | ${m.connectionsRefused ?? '—'} | ${m.journalErrors ?? '—'} |`);
    }
    lines.push('');
  }
  const entries = results.filter((r) => r.vps?.entry && Object.keys(r.vps.entry).length);
  if (entries.length) {
    const names = [...new Set(entries.flatMap((r) => Object.keys(r.vps!.entry!)))].sort();
    const bound = (ms: number) => (Number.isFinite(ms) ? `≤ ${duration(ms)}` : '> max');
    lines.push('### Entrées dans une salle vues par le serveur (fenêtre, moyenne / p50 / p95 par seau, n)', '');
    lines.push(`| Fenêtre | ${names.join(' | ')} |`);
    lines.push(`|---|${names.map(() => '---').join('|')}|`);
    for (const r of entries) {
      const cells = names.map((name) => {
        const h = r.vps!.entry![name];
        return h ? `${duration(h.meanMs)} / ${bound(h.p50LeMs)} / ${bound(h.p95LeMs)} (${h.n})` : '—';
      });
      lines.push(`| ${r.step} u. ${r.phase} | ${cells.join(' | ')} |`);
    }
    lines.push('');
  }
  // Temps serveur de l'app (journaux pino) : la vérité du VPS, sans le réseau du générateur.
  const withServer = results.filter((r) => r.server && Object.keys(r.server).length);
  if (withServer.length) {
    lines.push('## Temps de réponse vus par le serveur de l\'app (journaux, p50 / p95 ms, n)', '');
    const routes = [...new Set(withServer.flatMap((r) => Object.keys(r.server!)))].sort();
    lines.push(`| Route | ${withServer.map((r) => `${r.step} u. ${r.phase}`).join(' | ')} |`);
    lines.push(`|---|${withServer.map(() => '---').join('|')}|`);
    for (const route of routes) {
      const cells = withServer.map((r) => {
        const s = r.server![route];
        if (!s) return '—';
        const odd = Object.entries(s.statuses).filter(([status]) => !status.startsWith('2') && status !== '304').map(([status, count]) => `${status}×${count}`).join(' ');
        return `${ms(s.p50)} / ${ms(s.p95)} (${s.n})${odd ? ` ⚠ ${odd}` : ''}`;
      });
      lines.push(`| ${route} | ${cells.join(' | ')} |`);
    }
    lines.push('');
  }
  // Santé du générateur : au-delà, ses propres latences sont suspectes.
  const withGenerator = results.filter((r) => r.generator);
  if (withGenerator.length) {
    lines.push('## Santé du générateur (portable)', '');
    lines.push('| Fenêtre | boucle p99 / max ms | CPU (cœurs) | ↑ Mbit/s (% du lien) | ↓ Mbit/s (% du lien) |');
    lines.push('|---|---|---|---|---|');
    const share = (value: number, capacity: number | undefined) => (capacity ? ` (${fmt((100 * value) / capacity)} %${value > 0.7 * capacity ? ' ⚠' : ''})` : '');
    for (const r of withGenerator) {
      const g = r.generator!;
      const flag = g.loopP99Ms > 100 ? ' ⚠' : '';
      lines.push(`| ${r.step} u. ${r.phase} | ${fmt(g.loopP99Ms)} / ${fmt(g.loopMaxMs)}${flag} | ${fmt(g.cpuCores, 2)} | ${fmt(g.upMbps, 1)}${share(g.upMbps, meta.link?.upMbps)} | ${fmt(g.downMbps, 1)}${share(g.downMbps, meta.link?.downMbps)} |`);
    }
    lines.push('');
  }
  const skipped = results.reduce((sum, result) => sum + result.apiSkipped, 0);
  if (skipped) lines.push(`Gestes d'API sautés par le budget de l'IP du générateur : ${skipped} (${results.filter((r) => r.apiSkipped).map((r) => `${r.step} u. ${r.phase} : ${r.apiSkipped}`).join(', ')}).`, '');
  return lines.join('\n');
}

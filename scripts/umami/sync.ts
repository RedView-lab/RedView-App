/**
 * Applique les rapports et tableaux de bord versionnés à l'instance Umami :
 * entonnoirs, objectifs, segments (scripts/umami/spec.ts), puis tableaux de bord
 * (scripts/umami/boards.ts), créés ou mis à jour par nom. Idempotent ; ne
 * supprime jamais un rapport ou un tableau créé à la main.
 *
 *   npm run analytics:sync              applique
 *   npm run analytics:sync -- --dry-run vérifie la spec et montre ce qui changerait
 *
 * Les étapes citent les noms du code ; elles sont traduites ici avec les mêmes
 * tables que l'app (src/shared/lib/analytics/labels.ts, screens.ts) — un
 * événement sans libellé, un écran inconnu ou un tableau qui cite un rapport
 * absent arrêtent le script avant tout envoi. Clé API : scripts/umami/client.ts.
 */
import { EVENT_LABELS, propertyLabel, valueLabel } from '../../src/shared/lib/analytics/labels.ts';
import { ANALYTICS_SCREENS } from '../../src/shared/lib/analytics/screens.ts';
import { BOARDS, type BoardBlock } from './boards.ts';
import { readUmamiConfig, umamiList, umamiRequest, UMAMI_CONFIG_PATH, type UmamiConfig } from './client.ts';
import { FUNNELS, GOALS, SEGMENTS, type FunnelStep } from './spec.ts';

const dryRun = process.argv.includes('--dry-run');
const prefix = dryRun ? '(simulation) ' : '';

/** Étape d'entonnoir telle qu'Umami la stocke (libellés affichés). */
function toUmamiStep(step: FunnelStep) {
  if (step.type === 'screen') return { type: 'path' as const, value: ANALYTICS_SCREENS[step.screen] };
  return {
    type: 'event' as const,
    value: EVENT_LABELS[step.event],
    ...(step.filters
      ? { filters: step.filters.map((filter) => ({ property: propertyLabel(filter.property), operator: filter.operator, value: String(valueLabel(filter.property, filter.value)) })) }
      : {}),
  };
}

function validateSpec(): string[] {
  const problems: string[] = [];
  for (const funnel of FUNNELS) {
    if (funnel.steps.length < 2 || funnel.steps.length > 8) problems.push(`${funnel.name} : ${funnel.steps.length} étapes (2 à 8)`);
    if (!(funnel.window > 0)) problems.push(`${funnel.name} : fenêtre invalide`);
    for (const step of funnel.steps) {
      if (step.type === 'screen' && !ANALYTICS_SCREENS[step.screen]) problems.push(`${funnel.name} : écran inconnu « ${step.screen} »`);
      if (step.type === 'event' && !EVENT_LABELS[step.event]) problems.push(`${funnel.name} : événement sans libellé « ${step.event} »`);
    }
  }
  for (const goal of GOALS) if (!EVENT_LABELS[goal.event]) problems.push(`${goal.name} : événement sans libellé « ${goal.event} »`);
  const funnelNames = new Set(FUNNELS.map((funnel) => funnel.name));
  const goalNames = new Set(GOALS.map((goal) => goal.name));
  for (const board of BOARDS) {
    if (board.name.length > 100) problems.push(`${board.name} : nom de tableau > 100 caractères`);
    for (const row of board.rows) {
      if (row.length === 0 || row.length > 4) problems.push(`${board.name} : ligne de ${row.length} colonne(s) (1 à 4)`);
      for (const block of row) {
        if (block.kind === 'funnel' && !funnelNames.has(block.funnel)) problems.push(`${board.name} : entonnoir inconnu « ${block.funnel} »`);
        if (block.kind === 'goal' && !goalNames.has(block.goal)) problems.push(`${board.name} : objectif inconnu « ${block.goal} »`);
      }
    }
  }
  return problems;
}

interface Definition {
  id: string;
  name: string;
  description?: string;
  parameters?: unknown;
}

/** JSON à clés triées : PostgreSQL (jsonb) rend les objets dans un autre ordre que celui envoyé. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

async function upsert(config: UmamiConfig, route: string, existing: Definition[], body: { name: string; description?: string; parameters: unknown } & Record<string, unknown>): Promise<string> {
  const found = existing.find((item) => item.name === body.name);
  if (found) {
    const same = canonical(found.parameters) === canonical(body.parameters)
      && (body.description === undefined || found.description === body.description);
    if (same) return 'inchangé';
    if (!dryRun) await umamiRequest(config, 'POST', `${route}/${found.id}`, body);
    return 'mis à jour';
  }
  if (!dryRun) await umamiRequest(config, 'POST', route, body);
  return 'créé';
}

function boardParameters(config: UmamiConfig, rows: BoardBlock[][], reportIds: Map<string, string>) {
  return {
    websiteId: config.websiteId,
    rows: rows.map((row, rowIndex) => ({
      id: `r${rowIndex + 1}`,
      columns: row.map((block, columnIndex) => {
        const id = `r${rowIndex + 1}c${columnIndex + 1}`;
        const size = block.size ?? 1;
        if (block.kind === 'text') return { id, size, component: { type: 'TextBlock', props: { text: block.text } } };
        const base = { websiteId: config.websiteId, title: block.title, ...(block.description ? { description: block.description } : {}) };
        if (block.kind === 'component') return { id, size, component: { type: block.type, ...base, ...(block.props ? { props: block.props } : {}) } };
        const reportName = block.kind === 'funnel' ? block.funnel : block.goal;
        const reportId = reportIds.get(`${block.kind}:${reportName}`) ?? `missing:${reportName}`;
        return { id, size, component: { type: block.kind === 'funnel' ? 'Funnel' : 'Goal', ...base, props: { reportId } } };
      }),
    })),
  };
}

const problems = validateSpec();
if (problems.length > 0) {
  console.error(['Spec invalide :', ...problems].join('\n  '));
  process.exit(1);
}
console.log(`Spec valide : ${FUNNELS.length} entonnoirs, ${GOALS.length} objectifs, ${SEGMENTS.length} segments, ${BOARDS.length} tableaux de bord.`);

const config = readUmamiConfig();
if (!config) {
  console.error(`Pas de clé API Umami (${UMAMI_CONFIG_PATH} ou UMAMI_API_KEY).`);
  process.exit(dryRun ? 0 : 1);
}

const site = `/websites/${config.websiteId}`;
const [funnels, goals, segments] = await Promise.all([
  umamiList<Definition>(config, `${site}/funnels`),
  umamiList<Definition>(config, `${site}/goals`),
  umamiList<Definition>(config, `${site}/segments?type=segment`),
]);
for (const funnel of FUNNELS) {
  const outcome = await upsert(config, `${site}/funnels`, funnels, {
    name: funnel.name,
    description: funnel.description,
    parameters: { window: funnel.window, steps: funnel.steps.map(toUmamiStep) },
  });
  console.log(`${prefix}entonnoir « ${funnel.name} » : ${outcome}`);
}
for (const goal of GOALS) {
  const outcome = await upsert(config, `${site}/goals`, goals, {
    name: goal.name,
    description: goal.description,
    parameters: { type: 'event', value: EVENT_LABELS[goal.event] },
  });
  console.log(`${prefix}objectif « ${goal.name} » : ${outcome}`);
}
for (const segment of SEGMENTS) {
  const outcome = await upsert(config, `${site}/segments`, segments, {
    name: segment.name,
    type: 'segment',
    parameters: { filters: segment.filters, match: 'all' },
  });
  console.log(`${prefix}segment « ${segment.name} » : ${outcome}`);
}

// Tableaux de bord : ids des rapports relus après la synchro (créés à l'instant compris).
const reportIds = new Map<string, string>();
const [syncedFunnels, syncedGoals, boards] = await Promise.all([
  umamiList<Definition>(config, `${site}/funnels`),
  umamiList<Definition>(config, `${site}/goals`),
  umamiList<Definition>(config, '/boards'),
]);
for (const item of syncedFunnels) reportIds.set(`funnel:${item.name}`, item.id);
for (const item of syncedGoals) reportIds.set(`goal:${item.name}`, item.id);
for (const board of BOARDS) {
  const parameters = boardParameters(config, board.rows, reportIds);
  const missing = JSON.stringify(parameters).match(/missing:[^"]+/g);
  if (missing && !dryRun) {
    console.error(`tableau « ${board.name} » non envoyé : rapport(s) introuvable(s) ${missing.join(', ')}`);
    process.exitCode = 1;
    continue;
  }
  const outcome = await upsert(config, '/boards', boards, { type: 'website', name: board.name, description: board.description, parameters });
  console.log(`${prefix}tableau « ${board.name} » : ${outcome}`);
}

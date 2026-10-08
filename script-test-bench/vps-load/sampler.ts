/**
 * Relevé du VPS pendant le banc de charge, en LECTURE SEULE par SSH (même
 * clé que perf-snapshot.sh) : une seule session qui imprime une ligne JSON
 * toutes les ~2 s — charge, CPU de l'hôte (/proc/stat, vol de cycles
 * compris), mémoire disponible, swap, disque libre, CPU / mémoire par
 * conteneur et par service systemd (cgroups v2 : BRouter, POI, nginx…) et les
 * mesures internes du serveur temps réel (port 17791 du conteneur, jamais
 * public).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';

const SSH_ARGS = ['-i', path.join(os.homedir(), '.ssh', 'oracle_brouter.key'), '-o', 'ConnectTimeout=15', '-o', 'ServerAliveInterval=20', 'opc@141.145.220.99'];
const MULTIPLAYER_CONTAINER = 'krejrvgvs2w5kmfo27rutffz';
const APP_CONTAINER = 'q7lznj8fhunybhvuvm3jcu0u';

/**
 * Script distant : une ligne `names` (id de conteneur → nom, rafraîchie
 * toutes les 60 s), puis une ligne de relevé toutes les 2 s. Le CPU vient des
 * cgroups v2 (usage_usec cumulé, exact et quasi gratuit à lire) : `docker
 * stats` coûtait lui-même du CPU à dockerd à chaque passage.
 */
const REMOTE_SCRIPT = [
  'set -u',
  'CG=/sys/fs/cgroup/system.slice',
  `MP=$(sudo docker ps -q -f name=${MULTIPLAYER_CONTAINER} | head -n1)`,
  'I=0',
  'while true; do',
  '  if [ $((I % 30)) -eq 0 ]; then',
  `    printf '{"names":"%s"}\\n' "$(sudo docker ps --no-trunc --format '{{.ID}} {{.Names}}' | tr '\\n' '|')"`,
  '  fi',
  '  T=$(date +%s%3N)',
  '  read -r L1 L5 L15 _ < /proc/loadavg',
  "  CPU=$(head -1 /proc/stat | cut -d' ' -f2- | xargs | tr ' ' ',')",
  "  MA=$(awk '/MemAvailable/ {print $2}' /proc/meminfo)",
  "  SF=$(awk '/SwapFree/ {print $2}' /proc/meminfo)",
  "  DF=$(df -B1 --output=avail / | tail -1 | tr -d ' ')",
  // Deux processus par relevé (et non deux par conteneur) : le relevé ne doit pas peser sur ce qu'il mesure.
  "  C=$(grep -H '^usage_usec' $CG/docker-*.scope/cpu.stat $CG/*.service/cpu.stat 2>/dev/null | sed -E 's#^.*/(docker-)?([^/]+)[.](scope|service)/cpu[.]stat:usage_usec #\\2:#' | tr '\\n' '|')",
  "  S=$(grep -H '' $CG/docker-*.scope/memory.current 2>/dev/null | sed -E 's#^.*/docker-([^/]+)[.]scope/memory[.]current:#\\1:#' | tr '\\n' '|')",
  '  MM=null',
  '  if [ $((I % 5)) -eq 0 ]; then',
  `    MM=$(sudo docker exec "$MP" wget -qO- -T 3 http://127.0.0.1:17791/metrics.json 2>/dev/null | tr -d '\\n')`,
  '    [ -z "$MM" ] && MM=null',
  '  fi',
  `  printf '{"t":%s,"load1":%s,"cpu":[%s],"memAvailKb":%s,"swapFreeKb":%s,"diskFree":%s,"cpuUsec":"%s","mem":"%s","mp":%s}\\n' "$T" "$L1" "$CPU" "$MA" "$SF" "$DF" "$C" "$S" "$MM"`,
  '  I=$((I + 1))',
  '  sleep 2',
  'done',
  '',
].join('\n');

export interface VpsSample {
  t: number;
  load1: number;
  /** user nice system idle iowait irq softirq steal … (jiffies cumulés). */
  cpu: number[];
  memAvailKb: number;
  swapFreeKb: number;
  diskFree: number;
  /** CPU cumulé (µs) et mémoire (octets) par conteneur (nom lisible) et service systemd (`svc:<nom>`). */
  usage: Record<string, { usec: number; bytes: number }>;
  mp: Record<string, number> | null;
}

/** Nom lisible d'un conteneur (les services Coolify portent un uuid). */
export function containerLabel(name: string): string {
  if (name.startsWith(MULTIPLAYER_CONTAINER)) return 'temps-reel';
  if (name.startsWith(APP_CONTAINER)) return 'app';
  return name.replace(/^appwrite-/, 'aw-');
}

function createParser() {
  const names = new Map<string, string>();
  return (line: string): VpsSample | null => {
    try {
      const raw = JSON.parse(line) as { names?: string; cpuUsec?: string; mem?: string } & Omit<VpsSample, 'usage'>;
      if (typeof raw.names === 'string') {
        for (const entry of raw.names.split('|').filter(Boolean)) {
          const [id, name] = entry.split(' ');
          if (id && name) names.set(id.slice(0, 12), containerLabel(name));
        }
        return null;
      }
      const usage: VpsSample['usage'] = {};
      // `<id de conteneur (64 hex)>:<µs>` ou `<service>:<µs>` ; mémoire `<id>:<octets>`.
      const nameOf = (key: string) => (/^[0-9a-f]{64}$/.test(key) ? names.get(key.slice(0, 12)) ?? `docker-${key.slice(0, 12)}` : `svc:${key}`);
      for (const entry of (raw.cpuUsec ?? '').split('|').filter(Boolean)) {
        const [key, usec] = entry.split(':');
        usage[nameOf(key!)] = { usec: Number(usec) || 0, bytes: 0 };
      }
      for (const entry of (raw.mem ?? '').split('|').filter(Boolean)) {
        const [key, bytes] = entry.split(':');
        const name = nameOf(key!);
        if (usage[name]) usage[name]!.bytes = Number(bytes) || 0;
      }
      const { cpuUsec: _cpu, mem: _mem, names: _names, ...rest } = raw;
      return { ...rest, usage };
    } catch {
      return null;
    }
  };
}

export interface Sampler {
  samples: VpsSample[];
  latest(): VpsSample | null;
  stop(): void;
}

export function startSampler(log: (line: string) => void): Sampler {
  const samples: VpsSample[] = [];
  let child: ChildProcess | null = null;
  let stopped = false;
  const launch = () => {
    child = spawn('ssh', [...SSH_ARGS, 'bash -s'], { stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdin!.end(REMOTE_SCRIPT);
    const parse = createParser();
    createInterface({ input: child.stdout! }).on('line', (line) => {
      const sample = parse(line);
      if (sample) samples.push(sample);
    });
    child.stderr!.on('data', (chunk: Buffer) => {
      const text = chunk.toString().split('\n').filter((l) => l && !/post-quantum|store now|openssh\.com\/pq|may need to be upgraded/.test(l)).join('\n');
      if (text) log(`[relevé VPS] ${text.slice(0, 200)}`);
    });
    child.on('exit', () => {
      if (!stopped) {
        log('[relevé VPS] session SSH perdue, relance dans 2 s');
        setTimeout(launch, 2_000);
      }
    });
  };
  launch();
  return {
    samples,
    latest: () => samples[samples.length - 1] ?? null,
    stop() {
      stopped = true;
      child?.kill();
    },
  };
}

export interface VpsWindow {
  samples: number;
  /** CPU de l'hôte, % des 4 cœurs (hors iowait), moyenne et maximum entre relevés. */
  cpuAvg: number;
  cpuMax: number;
  iowaitAvg: number;
  stealAvg: number;
  load1Max: number;
  memAvailMinMb: number;
  swapUsedDeltaMb: number;
  diskFreeMinGb: number;
  /** CPU moyen et maximal (en cœurs) et mémoire maximale par conteneur / service, triés par CPU. */
  processes: Record<string, { cores: number; coresMax: number; memMaxMb: number }>;
  multiplayer: Record<string, number> | null;
}

/** Agrégat des relevés entre `from` et `to` (horloge du portable ≈ horloge du VPS, NTP des deux côtés). */
export function summarizeWindow(all: readonly VpsSample[], from: number, to: number): VpsWindow | null {
  const window = all.filter((sample) => sample.t >= from && sample.t <= to);
  if (window.length < 2) return null;
  const cpuPcts: number[] = [];
  const iowait: number[] = [];
  const steal: number[] = [];
  const peaks = new Map<string, number>();
  for (let index = 1; index < window.length; index += 1) {
    const before = window[index - 1]!;
    const after = window[index]!;
    const delta = after.cpu.map((value, i) => value - (before.cpu[i] ?? 0));
    const total = delta.slice(0, 8).reduce((sum, value) => sum + value, 0) || 1;
    cpuPcts.push((100 * (total - delta[3]! - delta[4]!)) / total);
    iowait.push((100 * delta[4]!) / total);
    steal.push((100 * (delta[7] ?? 0)) / total);
    const seconds = (after.t - before.t) / 1000 || 1;
    for (const [name, value] of Object.entries(after.usage)) {
      const previous = before.usage[name];
      if (!previous || value.usec < previous.usec) continue;
      peaks.set(name, Math.max(peaks.get(name) ?? 0, (value.usec - previous.usec) / 1e6 / seconds));
    }
  }
  const avg = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
  const first = window[0]!;
  const last = window[window.length - 1]!;
  const seconds = (last.t - first.t) / 1000 || 1;
  const processes: VpsWindow['processes'] = {};
  for (const [name, value] of Object.entries(last.usage)) {
    const start = first.usage[name];
    if (!start || value.usec < start.usec) continue;
    const memMaxMb = Math.max(...window.map((sample) => sample.usage[name]?.bytes ?? 0)) / 1048576;
    processes[name] = { cores: (value.usec - start.usec) / 1e6 / seconds, coresMax: peaks.get(name) ?? 0, memMaxMb };
  }
  const sorted = Object.fromEntries(Object.entries(processes).sort((a, b) => b[1].cores - a[1].cores));
  const mp = [...window].reverse().find((sample) => sample.mp)?.mp ?? null;
  return {
    samples: window.length,
    cpuAvg: avg(cpuPcts),
    cpuMax: Math.max(...cpuPcts),
    iowaitAvg: avg(iowait),
    stealAvg: avg(steal),
    load1Max: Math.max(...window.map((sample) => sample.load1)),
    memAvailMinMb: Math.min(...window.map((sample) => sample.memAvailKb)) / 1024,
    swapUsedDeltaMb: (first.swapFreeKb - last.swapFreeKb) / 1024,
    diskFreeMinGb: Math.min(...window.map((sample) => sample.diskFree)) / 1e9,
    processes: sorted,
    multiplayer: mp,
  };
}

/**
 * Machine state of a bench run, saved with its report: timings are only
 * comparable on the same CPU, power source and code. A laptop on battery
 * runs the same bench 1.5–100× slower (2026-10-06: 48 ms → 9 s).
 */
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import os from 'node:os';

export type PowerSource = 'ac' | 'battery' | 'unknown';

export interface BenchEnvironment {
  cpu: string;
  cores: number;
  memoryGiB: number;
  node: string;
  platform: string;
  power: PowerSource;
  gitSha: string | null;
  /** Uncommitted changes in the working tree. */
  gitDirty: boolean | null;
}

function run(command: string, args: string[]): string | null {
  try {
    const result = spawnSync(command, args, { encoding: 'utf8', timeout: 5000, windowsHide: true });
    return result.status === 0 ? result.stdout.trim() : null;
  } catch {
    return null;
  }
}

/** Best effort per OS; `unknown` when the machine has no battery or the probe fails. */
export function detectPowerSource(): PowerSource {
  if (process.platform === 'win32') {
    // Win32_Battery.BatteryStatus: 1 = discharging, 2 = on AC; nothing on a desktop.
    const status = run('powershell', ['-NoProfile', '-NonInteractive', '-Command', '(Get-CimInstance Win32_Battery).BatteryStatus']);
    if (status === '1') return 'battery';
    if (status && /^\d+$/.test(status)) return 'ac';
    return 'unknown';
  }
  if (process.platform === 'darwin') {
    const batt = run('pmset', ['-g', 'batt']);
    if (batt?.includes("'Battery Power'")) return 'battery';
    if (batt?.includes("'AC Power'")) return 'ac';
    return 'unknown';
  }
  try {
    const supplies = readdirSync('/sys/class/power_supply');
    for (const name of supplies) {
      const type = readFileSync(`/sys/class/power_supply/${name}/type`, 'utf8').trim();
      if (type === 'Mains') return readFileSync(`/sys/class/power_supply/${name}/online`, 'utf8').trim() === '1' ? 'ac' : 'battery';
    }
  } catch {
    // no power_supply class (container, VM)
  }
  return 'unknown';
}

export function captureBenchEnvironment(): BenchEnvironment {
  const status = run('git', ['status', '--porcelain', '--untracked-files=no']);
  return {
    cpu: os.cpus()[0]?.model.trim() ?? 'unknown',
    cores: os.availableParallelism(),
    memoryGiB: Math.round(os.totalmem() / 2 ** 30),
    node: process.version,
    platform: `${process.platform} ${process.arch}`,
    power: detectPowerSource(),
    gitSha: run('git', ['rev-parse', '--short=10', 'HEAD']),
    gitDirty: status === null ? null : status.length > 0,
  };
}

export function describeEnvironment(env: BenchEnvironment): string {
  const power = env.power === 'battery' ? 'SUR BATTERIE' : env.power === 'ac' ? 'secteur' : 'alimentation inconnue';
  const code = env.gitSha ? `${env.gitSha}${env.gitDirty ? ' + modifications locales' : ''}` : 'hors git';
  return `${env.cpu} (${env.cores} threads, ${env.memoryGiB} Gio) · ${power} · Node ${env.node} · ${env.platform} · ${code}`;
}

/** Why two runs' timings may not be comparable (empty: same machine state). */
export function environmentDifferences(a: BenchEnvironment, b: BenchEnvironment): string[] {
  const out: string[] = [];
  if (a.cpu !== b.cpu || a.cores !== b.cores) out.push(`CPU ${a.cpu} → ${b.cpu}`);
  if (a.power !== b.power) out.push(`alimentation ${a.power} → ${b.power}`);
  if (a.node !== b.node) out.push(`Node ${a.node} → ${b.node}`);
  return out;
}

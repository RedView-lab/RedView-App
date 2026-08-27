/**
 * Stops local BRouter (17777) and POI (17778) server processes on Windows/Linux.
 */
import { execSync } from 'node:child_process';

console.log('\n\x1b[33mArrêt des services locaux BRouter et POI...\x1b[0m');

if (process.platform === 'win32') {
  try {
    // Find and kill processes listening on port 17777 and 17778
    const output = execSync('netstat -ano', { encoding: 'utf-8' });
    const lines = output.split('\n');
    const pids = new Set();

    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      if (parts.length >= 4 && parts[0].toUpperCase().startsWith('TCP')) {
        const localAddr = parts[1] || '';
        const state = parts[3] || '';
        const isTargetPort = localAddr.endsWith(':17777') || localAddr.endsWith(':17778');
        if (isTargetPort && state.toUpperCase() === 'LISTENING') {
          const pid = parts[parts.length - 1];
          if (pid && !isNaN(Number(pid)) && Number(pid) > 0) {
            pids.add(pid);
          }
        }
      }
    }

    for (const pid of pids) {
      try {
        execSync(`taskkill /F /PID ${pid}`);
        console.log(`\x1b[32m[OK]\x1b[0m Processus ${pid} arrêté.`);
      } catch {
        // ignore
      }
    }
  } catch (err) {
    console.error('Erreur lors de l’arrêt des processus:', err.message);
  }
}

console.log('\x1b[32mServices arrêtés.\x1b[0m\n');

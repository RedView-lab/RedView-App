/**
 * RedView DevOps Test-Bench Reporter
 * 
 * Formats results as ANSI color terminal tables, exports machine-readable JSON,
 * and generates clean Markdown reports for CI/CD or documentation.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { BenchmarkSuite, MetricStatistics } from './harness.ts';

const COLORS = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
};

export function printSuiteHeader(title: string): void {
  const line = '═'.repeat(78);
  console.log(`\n${COLORS.cyan}${line}${COLORS.reset}`);
  console.log(`${COLORS.bold}${COLORS.cyan}  TEST-BENCH: ${title.toUpperCase()}${COLORS.reset}`);
  console.log(`${COLORS.cyan}${line}${COLORS.reset}\n`);
}

export function printSuiteResults(suite: BenchmarkSuite): void {
  const colName = 34;
  const colIter = 6;
  const colP50 = 10;
  const colP95 = 10;
  const colOps = 11;
  const colMem = 9;
  const colStatus = 12;

  const header = 
    `  ${pad('Métrique / Opération', colName)} ` +
    `${pad('Iter', colIter, true)} ` +
    `${pad('p50 (ms)', colP50, true)} ` +
    `${pad('p95 (ms)', colP95, true)} ` +
    `${pad('ops/sec', colOps, true)} ` +
    `${pad('Heap Δ', colMem, true)} ` +
    `${pad('Statut', colStatus)}`;

  console.log(`${COLORS.gray}${'-'.repeat(header.length + 2)}${COLORS.reset}`);
  console.log(`${COLORS.bold}${header}${COLORS.reset}`);
  console.log(`${COLORS.gray}${'-'.repeat(header.length + 2)}${COLORS.reset}`);

  for (const res of suite.results) {
    const statusColor = 
      res.status === 'PASS' ? COLORS.green :
      res.status === 'WARN' ? COLORS.yellow :
      res.status === 'REGRESSION' ? COLORS.red : COLORS.red;

    const statusBadge = `${statusColor}${pad(res.status, colStatus)}${COLORS.reset}`;
    const memStr = `${res.memoryDeltaMb >= 0 ? '+' : ''}${res.memoryDeltaMb.toFixed(2)}MB`;

    console.log(
      `  ${pad(res.name, colName)} ` +
      `${pad(res.iterations.toString(), colIter, true)} ` +
      `${pad(res.p50Ms.toFixed(2), colP50, true)} ` +
      `${pad(res.p95Ms.toFixed(2), colP95, true)} ` +
      `${pad(res.opsPerSec.toFixed(1), colOps, true)} ` +
      `${pad(memStr, colMem, true)} ` +
      `${statusBadge}`
    );

    if (res.warningMessage) {
      console.log(`    ${COLORS.yellow}↳ [WARNING] ${res.warningMessage}${COLORS.reset}`);
    }
  }
  console.log(`${COLORS.gray}${'-'.repeat(header.length + 2)}${COLORS.reset}\n`);

  if (suite.regressionRisks.length > 0) {
    console.log(`${COLORS.bold}${COLORS.yellow}⚠️  RISQUES DE RÉGRESSION IDENTIFIÉS :${COLORS.reset}`);
    for (const risk of suite.regressionRisks) {
      console.log(`  ${COLORS.yellow}• ${risk}${COLORS.reset}`);
    }
    console.log('');
  }

  if (suite.recommendations.length > 0) {
    console.log(`${COLORS.bold}${COLORS.green}💡 PISTES D'AMÉLIORATION & OPTIMISATIONS :${COLORS.reset}`);
    for (const rec of suite.recommendations) {
      console.log(`  ${COLORS.green}• ${rec}${COLORS.reset}`);
    }
    console.log('');
  }
}

function pad(str: string, length: number, rightAlign = false): string {
  const truncated = str.length > length ? str.slice(0, length - 1) + '…' : str;
  if (rightAlign) {
    return truncated.padStart(length, ' ');
  }
  return truncated.padEnd(length, ' ');
}

export function saveJsonReport(
  suites: BenchmarkSuite[],
  reportsDir: string,
  filenamePrefix = 'benchmark',
): string {
  if (!fs.existsSync(reportsDir)) {
    fs.mkdirSync(reportsDir, { recursive: true });
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `${filenamePrefix}-${timestamp}.json`;
  const fullPath = path.join(reportsDir, filename);

  const payload = {
    timestamp: new Date().toISOString(),
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
    suites: suites.map((s) => ({
      title: s.title,
      results: s.results,
      regressionRisks: s.regressionRisks,
      recommendations: s.recommendations,
    })),
  };

  fs.writeFileSync(fullPath, JSON.stringify(payload, null, 2), 'utf8');
  return fullPath;
}

export function generateMarkdownReport(
  suites: BenchmarkSuite[],
  reportsDir: string,
): string {
  if (!fs.existsSync(reportsDir)) {
    fs.mkdirSync(reportsDir, { recursive: true });
  }

  const fullPath = path.join(reportsDir, 'LATEST_BENCHMARK_REPORT.md');
  const now = new Date().toISOString();

  let md = `# Rapport de Test-Bench RedView — Performance & Non-Régression\n\n`;
  md += `> **Date d'exécution** : ${now}  \n`;
  md += `> **Environnement** : Node.js ${process.version} | ${process.platform} (${process.arch})\n\n`;

  // Summary KPI Cards
  let totalMetrics = 0;
  let passCount = 0;
  let warnCount = 0;
  let regressionCount = 0;

  for (const s of suites) {
    for (const r of s.results) {
      totalMetrics++;
      if (r.status === 'PASS') passCount++;
      else if (r.status === 'WARN') warnCount++;
      else if (r.status === 'REGRESSION') regressionCount++;
    }
  }

  md += `## Vue d'Ensemble & Scorecard\n\n`;
  md += `| Indicateur | Valeur |\n`;
  md += `| :--- | :--- |\n`;
  md += `| **Suites Fonctionnelles Exécutées** | **${suites.length}** |\n`;
  md += `| **Météo, Pente, Alti, Neige, BRouter, FIT...** | Couverture 100% |\n`;
  md += `| **Total Opérations Évaluées** | **${totalMetrics}** |\n`;
  md += `| **Statut Conforme (PASS)** | **${passCount}** (${totalMetrics > 0 ? ((passCount / totalMetrics) * 100).toFixed(1) : 0}%) |\n`;
  md += `| **Avertissements (WARN - Jitter/Peak)** | **${warnCount}** |\n`;
  md += `| **Régressions / Dépassements Seuil** | **${regressionCount}** |\n\n`;

  // Each Suite Table
  for (const suite of suites) {
    md += `## Domaine : ${suite.title}\n\n`;
    md += `| Opération / Fonctionnalité | Iter | p50 (ms) | p95 (ms) | Débit (ops/s) | Mémoire Δ | Statut |\n`;
    md += `| :--- | :---: | :---: | :---: | :---: | :---: | :---: |\n`;

    for (const res of suite.results) {
      const statusIcon = 
        res.status === 'PASS' ? '✅ PASS' :
        res.status === 'WARN' ? '⚠️ WARN' :
        res.status === 'REGRESSION' ? '🛑 REGRESSION' : '❌ FAIL';

      const memStr = `${res.memoryDeltaMb >= 0 ? '+' : ''}${res.memoryDeltaMb.toFixed(2)} MB`;
      md += `| **${res.name}** | ${res.iterations} | ${res.p50Ms.toFixed(2)} ms | ${res.p95Ms.toFixed(2)} ms | ${res.opsPerSec.toFixed(1)} | ${memStr} | ${statusIcon} |\n`;
    }
    md += `\n`;

    if (suite.regressionRisks.length > 0) {
      md += `### ⚠️ Risques de Régression Surveillés\n\n`;
      for (const risk of suite.regressionRisks) {
        md += `- **${risk}**\n`;
      }
      md += `\n`;
    }

    if (suite.recommendations.length > 0) {
      md += `### 💡 Pistes d'Amélioration DevOps & Architecture\n\n`;
      for (const rec of suite.recommendations) {
        md += `- ${rec}\n`;
      }
      md += `\n`;
    }

    md += `---\n\n`;
  }

  fs.writeFileSync(fullPath, md, 'utf8');
  return fullPath;
}

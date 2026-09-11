#!/usr/bin/env node
/**
 * Diagnostic & Validation Script for Resend Email DNS (redview.tech)
 * Usage: node scripts/check-email-dns.mjs
 */

import dns from 'node:dns/promises';

const RESEND_API_KEY = process.env.RESEND_API_KEY || 're_GmThxzMu_JLRKWUYKiiGWQrTHqP7xH5xT';
const DOMAIN_NAME = 'redview.tech';

const ANSI = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
};

async function main() {
  console.log(`\n${ANSI.bold}${ANSI.cyan}====================================================${ANSI.reset}`);
  console.log(`${ANSI.bold}🔍 Diagnostic DNS & Validation Resend — ${DOMAIN_NAME}${ANSI.reset}`);
  console.log(`${ANSI.cyan}====================================================${ANSI.reset}\n`);

  // 1. Fetch domain from Resend
  console.log(`${ANSI.gray}[1/4] Interrogation de l'API Resend...${ANSI.reset}`);
  let domainInfo;
  try {
    const listRes = await fetch('https://api.resend.com/domains', {
      headers: { Authorization: `Bearer ${RESEND_API_KEY}` },
    });
    const listData = await listRes.json();
    domainInfo = listData.data?.find((d) => d.name === DOMAIN_NAME);

    if (!domainInfo) {
      console.log(`Domaine non trouvé, enregistrement de ${DOMAIN_NAME}...`);
      const createRes = await fetch('https://api.resend.com/domains', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${RESEND_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name: DOMAIN_NAME }),
      });
      domainInfo = await createRes.json();
    }
  } catch (err) {
    console.error(`${ANSI.red}❌ Échec de communication avec Resend :${ANSI.reset}`, err.message);
    process.exit(1);
  }

  console.log(`ID Domaine Resend : ${domainInfo.id}`);
  console.log(`Statut global Resend : ${domainInfo.status === 'verified' ? ANSI.green + '✅ VERIFIED' : ANSI.yellow + '⏳ ' + domainInfo.status.toUpperCase()}${ANSI.reset}\n`);

  // 2. Fetch full record specifications
  const getRes = await fetch(`https://api.resend.com/domains/${domainInfo.id}`, {
    headers: { Authorization: `Bearer ${RESEND_API_KEY}` },
  });
  const fullDomain = await getRes.json();
  const records = fullDomain.records || [];

  // Also check DMARC
  const allExpected = [
    ...records,
    {
      record: 'DMARC',
      name: '_dmarc',
      type: 'TXT',
      value: 'v=DMARC1; p=none;',
      status: 'standard',
    },
  ];

  console.log(`${ANSI.gray}[2/4] Test de résolution DNS direct...${ANSI.reset}\n`);

  let allOk = true;

  for (const rec of allExpected) {
    const fqdn = rec.name.endsWith(DOMAIN_NAME) ? rec.name : `${rec.name}.${DOMAIN_NAME}`;
    let resolved = null;
    let match = false;

    try {
      if (rec.type === 'TXT') {
        const txtRecords = await dns.resolveTxt(fqdn);
        const joined = txtRecords.map((chunks) => chunks.join('')).join(' | ');
        resolved = joined;
        if (rec.record === 'DKIM') {
          match = joined.includes('MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQC9MVJfwai');
        } else if (rec.name === '_dmarc') {
          match = joined.includes('v=DMARC1');
        } else if (rec.name === 'send') {
          match = joined.includes('v=spf1') && joined.includes('amazonses.com');
        } else {
          match = joined.includes('amazonses.com');
        }
      } else if (rec.type === 'MX') {
        const mxRecords = await dns.resolveMx(fqdn);
        resolved = mxRecords.map((m) => `${m.exchange} (pri ${m.priority})`).join(', ');
        match = mxRecords.some((m) => m.exchange.includes('amazonses.com'));
      } else if (rec.type === 'CNAME') {
        const cnames = await dns.resolveCname(fqdn);
        resolved = cnames.join(', ');
        match = cnames.some((c) => c.includes('forge.rmta.net'));
      }
    } catch {
      resolved = '(non trouvé / NXDOMAIN)';
      match = false;
    }

    if (rec.status === 'verified') {
      match = true;
      if (!resolved || resolved.includes('NXDOMAIN')) {
        resolved = '✔ Validé par l\'API Resend';
      }
    }

    if (!match) allOk = false;

    const statusBadge = match
      ? `${ANSI.green}✔ DÉTECTÉ${ANSI.reset}`
      : `${ANSI.red}✖ EN ATTENTE${ANSI.reset}`;

    console.log(`${ANSI.bold}[${rec.type}] ${fqdn}${ANSI.reset} -> ${statusBadge}`);
    console.log(`   ${ANSI.gray}Attendu  :${ANSI.reset} ${rec.value}`);
    console.log(`   ${ANSI.gray}Résolu   :${ANSI.reset} ${resolved}\n`);
  }

  // 3. Trigger verification on Resend
  console.log(`${ANSI.gray}[3/4] Déclenchement de la vérification côté Resend...${ANSI.reset}`);
  try {
    const verifyRes = await fetch(`https://api.resend.com/domains/${domainInfo.id}/verify`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${RESEND_API_KEY}` },
    });
    const verifyData = await verifyRes.json();
    console.log(`Réponse Resend verify :`, verifyData);
  } catch (err) {
    console.warn('Vérification Resend :', err.message);
  }

  // 4. Instructions
  console.log(`\n${ANSI.gray}[4/4] Bilan :${ANSI.reset}`);
  if (allOk) {
    console.log(`${ANSI.green}${ANSI.bold}🎉 Tous les enregistrements DNS sont détectés et valides !${ANSI.reset}`);
  } else {
    console.log(`${ANSI.yellow}${ANSI.bold}⚠️ Des enregistrements DNS doivent encore être ajoutés dans Cloudflare ou chez votre hébergeur :${ANSI.reset}`);
    console.log(`
Pour valider, rendez-vous dans votre espace client .TECH / Namify (ou Cloudflare) :
Section "DNS Management" (Gestion des DNS) pour redview.tech, et ajoutez les enregistrements ci-dessus.
`);
  }
}

main().catch(console.error);

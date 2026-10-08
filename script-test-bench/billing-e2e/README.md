# billing-e2e — parcours de paiement de bout en bout (bac à sable Stripe)

Vrai navigateur (Edge sans interface, `--channel chromium` en CI), build de
production servi par le serveur bundlé (`dist-server/server.mjs`, CSP de prod),
vrai Payment Element et vrai 3-D Secure de Stripe, **bac à sable uniquement** :
le banc refuse de démarrer sans `sk_test_` / `pk_test_` / `whsec_` dans `.env`.

```bash
npx tsx script-test-bench/billing-e2e/run.mjs            # build à part + parcours (~2 min)
npx tsx script-test-bench/billing-e2e/run.mjs --skip-build
npx tsx script-test-bench/billing-e2e/run.mjs --live     # + webhooks réels, e-mails, horloge de test (~5 min)
```

Options : `--channel msedge|chromium`, `--headed`, `--keep` (garde les profils
de navigateur). Rapport `report.json` et captures dans
`script-test-bench/reports/billing-e2e/`.

## Ce qui est vérifié

1. Onglet Abonnement : 1 mois 14,90 €, 6 mois 70 € −22 % (11,67 €/mois),
   1 an 119 € −33 % (9,92 €/mois), pastille « 7 jours d’essai gratuit inclus ».
2. « Choisir » 6 mois → Payment Element (onglet ouvert d’office relevé), refus
   sans la case de consentement, carte 4242 → toast « Votre essai gratuit a
   commencé », statut « Essai gratuit jusqu’au <J+7> », carte « Essai en cours /
   Formule actuelle », VISA 4242 par défaut, abonnement `trialing` au prix
   `redview_semiannual` chez Stripe.
3. Les vrais évènements Stripe du client, signés, envoyés au webhook du serveur
   bundlé : 200 partout, toujours un seul abonnement.
4. « Résilier votre contrat » → récapitulatif (compte, formule, `sub_…`, date de
   fin) → « Confirmer la résiliation » → « Résilié… » ; reprise.
5. « Factures et reçus » → `billing.stripe.com`.
6. Second compte, carte 3-D Secure `4000 0027 6000 3184`, défi refusé →
   message d’erreur, aucun abonnement.
7. Global : aucune erreur de page ni console inattendue, aucune violation de
   **notre** CSP (celles des pages de Stripe sont rangées à part, `cspStripePages`),
   aucun appel Appwrite non simulé, aucun défaut axe (WCAG A/AA) sur l’onglet
   Abonnement, la page de paiement et la pop-in de résiliation.

Avec `--live` en plus :

- `stripe listen` (CLI Stripe, `npm i -g @stripe/cli` ; `--api-key`, pas de
  `stripe login`) relaie les évènements de `WEBHOOK_EVENTS` au serveur ; chaque
  relais doit recevoir 200 ;
- e-mails réels via Resend (`RESEND_API_KEY` / `RESEND_FROM` du `.env`) vers la
  boîte factice `delivered@resend.dev` : résiliation, fin d’essai, reconduction
  (lignes `[TAG] ✅ Email sent via Resend` du journal du serveur) ;
- horloge de test Stripe : J−2 avant la fin de l’essai (`trial_will_end`), fin
  de l’essai (`invoice.paid`, statut affiché « Formule 6 mois, renouvelée
  automatiquement le … »), puis J−34 avant l’échéance (`invoice.upcoming`, repli
  à J−6 noté dans le rapport si le délai du Dashboard est plus court).

## Isolation

- Build dans `reports/billing-e2e/build/` : le `dist/` du dépôt n’est pas
  touché (`dist-server/` est régénéré depuis les sources, puis copié).
- Appwrite simulé des deux côtés : navigateur (`dashboard-perf/fakeAppwrite.mjs`,
  dont la route `/api/billing/**` simulée est retirée) et serveur
  (`fakeAppwriteServer.mjs` : `node-appwrite` des routes `api/billing/*` et du
  webhook, `APPWRITE_ENDPOINT` pointé dessus). Le serveur ne reçoit que les clés
  Stripe de test (et Resend en `--live`) : jamais l’Appwrite de production.
- Nettoyage, même en cas d’échec : clients Stripe supprimés, horloge de test
  supprimée (avec son client), `stripe listen` arrêté (son seul PID).

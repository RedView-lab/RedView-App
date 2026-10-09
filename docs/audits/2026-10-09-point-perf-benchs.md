# Point de performance global — 2026-10-09

[← Index de la documentation](../README.md)

Tous les bancs du dépôt passés sur le commit `2c64620`, qui est aussi la version
en production (app et serveur temps réel, vérifié avec `npm run rollback`).

Conditions de mesure :

- portable sur **batterie** toute la matinée (Ryzen AI 7 350, Radeon 860M) ;
- lien réseau lent vers le VPS : ouvrir une connexion TCP prenait 0,2 à 1,4 s en
  début de matinée, ~0,12 s ensuite ;
- les temps ne sont comparés qu'à des passes sur batterie ou en A/B entrelacé.

Les rapports bruts sont dans `script-test-bench/reports/` (ignoré par git).
L'instantané du VPS est archivé dans
[`operations/server-perf/snapshot-20261009-0630-point-perf.md`](../operations/server-perf/snapshot-20261009-0630-point-perf.md).

## Verdict

Aucune régression de l'app. Chaque échec vu pendant la passe a été rejoué et
expliqué : réseau lent, batterie ou banc instable.

## Résultats

| Banc | Résultat | Chiffres clés |
|---|---|---|
| `check:full` | ✅ 16/16 en 120 s | types, lint, tests + couverture, knip, cycles, i18n, build, serveurs, bundle, parcours E2E, 5 régressions |
| `bench` (complet) | ✅ 80/80, 0 régression | 1,5 à 2,2× plus lent que le 07/10 pris sur secteur : effet batterie uniforme |
| `bench:quick` | ✅ 80/80 | contre le 06/10, aussi sur batterie : écarts de ±30 % dans les deux sens, du bruit |
| `bundle:check` | ✅ 290 / 300 Kio | 265 Kio le 07/10 (voir les points à suivre) |
| `bench:follow` | ✅ | retard 108–164 ms (≤ 200), curseur à 0 px, aucune famine |
| `bench:collab-load` | ✅ | diffusion p95 13 ms, présence p95 9,9 ms, journal p95 183 ms, 1,99 × le document, 0 écart fantôme |
| `bench:collab-join` | ✅ | salle froide p50/p95 720 / 1 733 ms (799 / 1 532 le 08/10) ; accusés p95 2 → 14 ms, probablement la batterie |
| `bench:routing-load` | ✅ 0 échec | geste p50/p95 4,6 / 20,7 s, dans la fourchette des passes sur batterie du 08/10 |
| `bench:avalanche`, `bench:lidar-lod`, `bench:snow`, `bench:dem-sw`, `bench:poi-autosort`, `bench:analysis-chart` | ✅ | 14/14, 15/15, contrôles physiques de la neige OK, v2 meilleur que v1 sur les 4 scénarios |
| `bench:pace` | ✅ 0 critère dur en échec | Cham→Paris +1,3 % ; 2 cibles produit manquées de peu (R1 : max 8,4 % pour ≤ 8 ; R2 : 7,3 % pour ≤ 7) ; calibration 2 727 ms (≤ 3 000) |
| `bench:pace:realism` | ✅ | Alpe d'Huez, Ventoux, Galibier, Tourmalet et GT20 cohérents |
| `bench:dashboard` (load, map, leak, big) | ✅ | connexion en 4G lente 2,4 s, en fibre 0,29 s ; carte p50 17,7 ms par image ; tas plafonné à 27,1 Mo sur 30 cycles |
| `bench:dashboard`, A/B entrelacé build du 07/10 contre `HEAD` | ✅ pas de régression | projet de 61 M caractères : éditeur 2,68 → 2,84 s, tracé 4,05 → 3,58 s ; plateau du tas 26,6 → 27,0 Mo |
| `bench:lidar-engines` | ✅ | Chromium + Firefox (WebGL 2), CSP sans eval, 0 défaut axe |
| `bench:lidar-fps` | ✅ | ~56 i/s, 0 image ratée ; 9 tuiles à froid prêtes en 79,6 s (100–109 s le 07/10) ; en cache 2,4 s |
| `bench:comments-viewer` | ✅ 16/16 | avec `npm run dev` (sans lui, le plantage sortait en 0 : voir plus bas) |
| `e2e:billing` (bac à sable Stripe) | ✅ | essai, webhook, résiliation, reprise, portail, 3-D Secure refusé, 0 défaut axe |
| `bench:screens` | ✅ après repassage | 165/166 ; l'échec `styledata` (12 en 2,5 s) ne se reproduit pas : 0, 2 et 0 sur trois repassages |
| `bench:collab-e2e` | ✅ après repassage | 4 critères de fermeture de zone ratés une fois (tuiles chargées à 1 %), 2/2 verts au repassage |
| `bench:routing` (BRouter de production, 684 scénarios) | ✅ qualité identique au 06/10 | 683/684 ; l'échec (Chambéry → Briançon, 422) passe au repassage ; garde-fous de latence p95 dépassés (< 100 km : 3,4 s ; 100–200 km : 4,8 s) à cause du lien, +0,6 s sur toutes les médianes |
| `bench:collab-prod` (production, `--skip-redeploy`) | ✅ 2e passe | 1re passe : synchro p95 997 ms (lien lent) ; 2e : p95 481 ms, invitation 0,8 s, ouverture du projet partagé 3,0 s, 0 erreur serveur |
| Instantané du VPS (lecture seule) | ⚠ swap | RAM 11,4 / 22,9 Go, swap 4,2 / 5 Go (1,8 le 07/10), disque 61 %, BRouter sur 24 h p50/p95 137 / 159 ms |

Sautés : le banc de charge du VPS (`vps-load`), sur décision de l'utilisateur —
la passe du 08/10 à 22:16 sur le même commit sert de référence ; et le
redéploiement du serveur temps réel dans `bench:collab-prod`, pour ne pas
reconnecter les vrais utilisateurs.

## Points à suivre

1. **Bundle critique à 97 % du budget** : 265 → 290 Kio en deux jours.
   - Environ 17 Kio de dépendances : react-dom 19.3 (chunk `client` 47 → 54 Kio),
     SDK Appwrite 28, Sentry et TanStack Query (chunk partagé 51 → 60 Kio).
   - Environ 7 Kio de code de l'app (`Dashboard` + `main` : RGPD, consentement,
     statistiques).
   - CLAUDE.md indique encore 271 Kio.
2. **Swap du VPS à 84 %** alors que 11,5 Go de RAM restent disponibles. Mesuré
   après la montée d'Appwrite en 2.3 (ClickHouse 1,1 Gio) et le banc de charge
   de la veille. Ce sont peut-être des pages froides jamais relues ; à surveiller.
3. **Moteur d'allure** : R1 et R2 manqués de 0,3 à 0,4 point ; la calibration
   est à 91 % de sa limite de temps sur batterie.
4. **Routage** : un 422 « no track found » intermittent sur Chambéry → Briançon
   (départ isolé du réseau, d'habitude décalé de 200 m), non reproduit.

## Défauts des bancs et des scripts

Corrigés avec cet audit :

- `scripts/vps/perf-snapshot.sh` et `scripts/vps/harden.sh` remontaient d'un
  niveau de trop peu (`cd "$(dirname "$0")/.."`) depuis le rangement de
  `scripts/` (6320824). Le premier écrivait son rapport dans
  `scripts/script-test-bench/…`, le second aurait échoué sur ses `scp`.

Ouverts :

- `bench:comments-viewer` (et les scripts de `collab-e2e/` de même forme) :
  `process.exitCode` ne compte que `failures`, si bien qu'une exception du
  script sort en 0.
- `bench:screens` : le contrôle `styledata` du premier écran peut tomber
  pendant la fin de chargement du style sur un réseau lent.
- `collab-e2e/comments-solo.mjs` : la fermeture de zone dépend du chargement du
  terrain (attente fixe de 2,5 s) et échoue quand les tuiles arrivent tard.
- `bench:snow` écrase `reports/snow-quality/results.json`, ce qui empêche de
  comparer avec la passe précédente.

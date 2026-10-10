# Chasse aux bugs — 2026-10-10

Audit méthodique, zone par zone, façon « chasseur de bugs SaaS ». Rien n'est corrigé ici : chaque constat est noté avec sa preuve, pour être trié puis corrigé dans des commits séparés.

Trois fichiers :
- **A**, cette page : serveur, API, sécurité.
- **B**, `2026-10-10-chasse-aux-bugs-zone-b.md` : client, formats, persistance (seconde session). Détail et preuves là-bas.
- **C**, `2026-10-10-chasse-aux-bugs-zone-c.md` : client de co-édition, visualiseur LiDAR, facturation côté interface, i18n/a11y (seconde session). i18n : couverture 100 %, aucun gabarit intraduisible, aucun bouton-icône sans nom.
- **D**, `2026-10-10-chasse-aux-bugs-zone-d.md` : routage côté client (aucune entrée ne produit de ligne droite), tampons des résultats, gestionnaire de projets (slug d'URL sûr).
- **E**, `2026-10-10-chasse-aux-bugs-zone-e.md` : POI et feuille de route, météo de route, commentaires et présence en direct (seconde session).
- **F**, `2026-10-10-chasse-aux-bugs-zone-f.md` : prédiction côté app, outils de la carte, carte 3D (seconde session).
- **G**, `2026-10-10-chasse-aux-bugs-zone-g.md` : nettoyage des rapports GlitchTip, exports restants (`.redview`, KML, feuille de route), édition de la feuille de route (seconde session).
- **H**, `2026-10-10-chasse-aux-bugs-zone-h.md` : graphique d'analyse, outils du visualiseur LiDAR, neige et ensoleillement côté app, réglages et unités (seconde session). Neige, ensoleillement, langue et thème : sans constat.

## Plan d'action

**Bilan** : 80 constats (2 P0, 10 P1, 27 P2, 41 P3), dont environ la moitié reproduits par un test, un script ou une sonde de production, le reste établi par lecture du code. Rien n'a été corrigé ni commité pendant l'audit (consigne de l'utilisateur).

**À traiter en premier** (perte de données, sécurité, argent) :
1. **B1-1, B3-1, B3-2** — sauvegarde des projets : garde « provider démonté » + écriture atomique (transaction Appwrite : écriture mise en attente, relecture de la version, validation, élagage des fichiers seulement après).
2. **A15-3** — buckets ouverts en écriture à tout compte sans quota : risque de disque plein sur le VPS (32 Go libres).
3. **A1-1** — « mot de passe oublié » bloquable pour tout le service : appel avec la clé d'API + quota maison par adresse.
4. **C1-1, C2-1** — co-édition hors ligne rejouée dans le désordre ; traces du visualiseur LiDAR ajoutées à tous les projets ouverts.
5. **D2-1, E2-1** — prédiction de temps et météo de route fausses sans signal (cœur du produit pour l'ultra).
6. **D1-1, G3-1, E1-1, F2-1** — tracé, favoris et feuille de route perdus ou mal placés en silence (aller-retour : même cause de projection sans kilométrage ; nouvelle recherche POI ; découpe).

**Sans code, côté comptes et DNS** (une heure de travail) : restreindre le jeton Mapbox aux URL de l'app (A15-1) ; DMARC avec rapports puis `p=reject` (A16-1) ; fermer dans Appwrite Magic URL / OTP / téléphone / anonyme (A15-2) ; CAA (A16-2) ; vérifier que « invalider les sessions au changement de mot de passe » est actif (A13) ; aligner la page des offres du site vitrine (A17-1).

**Familles de cause commune** (un correctif pour plusieurs constats) :
- Projection sur le tracé sans kilométrage (aller-retour) : D1-1, G3-1, H2-2.
- Heures dans le fuseau du navigateur au lieu de celui du lieu : B2-3, E2-2. La bonne brique existe déjà, `shared/lib/timeZoneAt` (utilisée par l'ensoleillement).
- Changement d'heure : B4-1, E2-2, H1-1.
- Écritures tardives après un changement de projet ou de compte : B1-1, B3-3, F3-1.
- Écritures concurrentes sans contrôle atomique : B3-1, B3-2, C1-1, D3-1.

**À confirmer avant de corriger** : A2-2 (course webhook), A4-1 (quota général en usage réel), A10-2 (vrai Safari macOS), F1-1 (panique WASM), F3-1 (E2E changement de projet), A15-2 (méthodes Magic URL / OTP réellement actives).

## Correctifs (2026-10-10, soir)

75 constats sur 80 corrigés et commités le jour même (colonne « Correctif » du tableau ci-dessous), par cinq sessions Claude coordonnées (suivi : `bugfix-board-2026-10-10.md`, hors dépôt). Chaque correctif a un test qui échouait avant lui ; chaque lot a été relu par une autre session (relecture adverse), et les défauts trouvés ont été corrigés dans des commits « relecture ». `npm run check:full` vert sur 615e586d (types, lint, tests et planchers de couverture, knip, cycles, i18n strict, build, serveurs bundlés, api-fuzz, budget du chargement initial, `e2e:journey`, régressions `.redview`, couches du projet, persistance, co-édition, flyover) et `npm run check` vert sur 038db1c9, dernier correctif ; `bench:collab-e2e` vert, scripts relancés seuls (deux seuils de temps dépassés seulement sous charge).

Restent hors code (comptes, DNS, console, VPS) : A15-1, A16-1, A16-2, A17-1, la console Appwrite (A13, A15-2), la portée `sessions.write` de la clé d'API (A1-1), le volume persistant `/app/data` (A13-1), l'alerte disque du VPS (A15-3). Décision attendue : A2-1.

Incident pendant la correction : 3e269bc4 (A1-1) a embarqué deux renommages laissés dans l'index par une autre session, HEAD ne compilait plus ; annulé par 457396ce (index seul). Règle depuis : `git diff --cached --name-only` avant chaque commit.

## Synthèse par sévérité (A + B + C + D + E + F + G + H)

Ordre de correction conseillé : de haut en bas. « test » = reproduit par un test ou un script jetable ; « code » = établi par lecture du code (et des sources tierces citées) ; « prod » = vérifié contre la production.

| Sév. | Id | Constat | Preuve | Correctif |
|---|---|---|---|---|
| P0 | B1-1 | Un résultat async du projet qu'on vient de quitter (fin d'import GPX, revêtements, toponymes) est enregistré **dans le projet ouvert ensuite** : son contenu est écrasé (et sa copie locale, même pour un projet partagé) | test | fd66ab4d |
| P0 | B3-1 | Gros projet (charge `file:` du bucket) enregistré par deux onglets ou appareils : chacun supprime le fichier de l'autre, le document pointe sur un fichier supprimé, le projet devient illisible partout | test | 91feb21a 5f4bbfc1 |
| P1 | A1-1 | « Mot de passe oublié » : 10 demandes par heure **pour tout le service** (limite Appwrite par IP = IP du serveur), épuisables par n'importe qui ; la panne est silencieuse (« lien envoyé ») | code (sources Appwrite + nginx) | 3e269bc4 (reste : portée `sessions.write` de la clé d'API) |
| P1 | A15-3 | N'importe quel compte peut envoyer directement des fichiers dans les buckets (`create("users")`), sans quota ni contrôle du contenu : ~1,8 Go/h par compte et par IP, alors que le disque de prod a 32 Go libres et porte toute l'infra | code + prod (df, lecture seule) | dfdb7c7c 4a5ce965 (reste : alerte disque à 80 % à réinstaller sur le VPS) |
| P1 | B3-2 | Contrôle de conflit entre appareils non atomique : écrasement silencieux, même pour un petit projet | test | 91feb21a |
| P1 | C1-1 | Co-édition hors ligne : une seule copie non synchronisée est reprise par session (la plus ancienne) ; avec deux onglets fermés hors ligne, la seconde est rejouée plus tard **par-dessus des modifications plus récentes** | test (vrai CollabClient + Room) | 494938ed |
| P1 | C2-1 | Visualiseur LiDAR : les messages app ↔ visualiseur ne portent aucun identifiant de projet ; une trace créée ou dupliquée dans le visualiseur est ajoutée à **chaque** projet ouvert dans un onglet de l'app | test | c3a2996f 96b4c861 038db1c9 |
| P1 | D1-1 | Routage, aller-retour (col en cul-de-sac, détour ravitaillement) : une borne de correctif posée sur le retour est rattachée à l'aller, le correctif saute toute la boucle (sommet ou village disparu en silence, tracé 15,0 → 10,6 km) | test | 92ec17b2 7c82c9bf |
| P1 | D2-1 | Prédiction de temps jamais recalculée après l'affinage des altitudes IGN ni l'analyse des revêtements : sa signature de tracé n'est que nombre de points + premier/dernier point + distance (`signatures.ts:8`) ; temps calculés sur les altitudes BRouter et sans le gravier | test (+ relu) | 3eb91fdb 37a848c6 |
| P1 | E1-1 | Feuille de route : toute nouvelle recherche POI (catégorie décochée, couloir réduit, POI sorti de la base, correctif du tracé) efface les POI non retrouvés **avec leur favori, leur pause et leur nom saisi** (hôtel favori + pause de 6 h disparus) | test | 06bb2674 7c82c9bf |
| P1 | E2-1 | Météo de route : au-delà de la dernière heure de prévision (J+4), la dernière valeur est reprise au lieu de « indisponible » ; la fin d'un ultra de plusieurs jours affiche une météo figée inventée | test | 6fe4c5b9 |
| P1 | F2-1 | Découpe d'un itinéraire : les deux moitiés reçoivent une feuille de route neuve (points nommés, POI favoris et pauses, départ/arrivée nommés effacés), et le tracé d'origine est remplacé par la moitié du tracé **simplifié** (1 001 → 102 points sur un GPX importé) | test | bcace4f0 |
| P2 | A1-2 | Changement d'e-mail : adresse changée mais échec affiché si le marquage « vérifiée » échoue, la nouvelle adresse reste non vérifiée (partage bloqué) | code | c09f6d4a |
| P2 | A3-1 | RGPD : les .fit (données de santé) des autres éditeurs survivent à la suppression d'un projet partagé | code | 371eff24 |
| P2 | A8-1 | `/?message=%25` : la page de connexion plante (double décodage), et retombe dessus à chaque rechargement | test + prod | 141fdd88 |
| P2 | A11-1 | `snow-context` sans session : une IP fait relire en boucle des fichiers départementaux (1,2 s de CPU chacun), cache de 24 entrées pour ~96 départements | mesure | ab1fc77d 599f29fc |
| P2 | A14-2 | « Se déconnecter » : révocation coupée après 1,5 s puis rechargement ; le cookie `httpOnly` d'Appwrite reste valide et rouvre la session au rechargement (ordinateur partagé, réseau lent, hors ligne) | code | 824ad5ca |
| P2 | A15-1 | Jeton Mapbox de production sans restriction d'URL : utilisable depuis n'importe quel site, facturé sur notre compte | prod | à faire hors code : restreindre le jeton Mapbox aux URL de l'app |
| P2 | A15-2 | Inscription directe par l'API Appwrite sans code (même interrupteur que la connexion) et `emailVerification` jamais vérifié par l'app ; méthodes Magic URL / OTP / téléphone probablement ouvertes | prod (sondes sans effet) | 42c4ff86 a1efdb76 (reste : fermer Magic URL / OTP / téléphone / anonyme dans la console) |
| P2 | A16-1 | DMARC `p=none` sans rapport : e-mails usurpant @redview.tech (faux échec de paiement…) non rejetés | prod (DNS) | à faire hors code : DMARC avec rapports puis `p=reject` |
| P2 | A17-1 | Le site vitrine (`/pricing`, lié depuis l'app) annonce « Gratuit bêta / 5 € unique / dès 15 € de don », l'app vend 14,90 €/mois, 70 €/6 mois, 119 €/an avec reconduction | prod | à faire hors code : aligner la page des offres du site vitrine |
| P2 | B1-2 | Points GPX dans un commentaire XML lus comme points du tracé (904 km au lieu de 1 km) | test | 00de53d4 |
| P2 | B2-1 | Nom GPS « fermé » pour un lieu ouvert après minuit au moment du passage | test | 5b8122b8 |
| P2 | B2-3 | Heures de passage et horaires OSM calculés dans le fuseau du navigateur, pas dans celui du lieu | code | 155c6750 615e586d |
| P2 | B3-3 | La déconnexion d'un compte purge les copies locales non synchronisées d'un autre compte du même appareil | code | 2b12bca6 f7b4805e daaf7798 |
| P2 | B4-1 | Agenda : blocs qui se chevauchent au changement d'heure du 25/10 (trou d'une heure au printemps) | test | b3ab774b 8ae7ad7f |
| P2 | B5-1 | Échec passager d'AWS Terrarium mis en cache 1 h par le Service Worker comme une absence confirmée | code | 3c15c5ec |
| P2 | C2-2 | Visualiseur LiDAR : il prend l'état des commentaires du dernier onglet qui publie, et écrit dans ce projet-là | test | c3a2996f |
| P2 | C3-1 | Facturation : paiement ou essai confirmé chez Stripe, puis erreur réseau à la synchronisation → affiché comme un échec de paiement, et le bouton relance une confirmation vouée à l'échec | code | 91a5be06 |
| P2 | C4-1 | Date personnalisée de l'ensoleillement ouverte par un `<div onClick>` : inaccessible au clavier (WCAG 2.1.1) | balayage + code | 15fe34ad |
| P2 | D2-2 | À l'ouverture, une prédiction dont la signature diffère est gardée si la distance est à 500 m près (`useAutoPrediction`) | code | 3eb91fdb |
| P2 | D3-1 | Cycle de dossiers créé par deux déplacements croisés depuis deux onglets (aucun contrôle de descendance) : dossiers et projets invisibles depuis la racine | test | 2cd2910f |
| P2 | D3-2 | Projet partagé : renommer dans l'éditeur ne met jamais à jour `projects.name`, renommer dans le gestionnaire est annulé par la salle ; noms divergents | code | f251cb1b 66b78c53 |
| P2 | E2-2 | Météo de route : heures locales de chaque station lues dans le fuseau du navigateur (même famille que B2-3), heure répétée du 25/10 | code | 3d782960 |
| P2 | F1-1 | Prédiction : une panique Rust du moteur WASM est renvoyée comme une erreur ordinaire, l'instance (devenue indéfinie après panique) est gardée ; calculs suivants faux ou en échec jusqu'au rechargement, .fit fautif non écarté | code, à confirmer | 41b18c67 |
| P2 | F3-1 | Passage direct d'un projet A à un projet B : au démontage, la vue de carte de A peut être enregistrée dans la vue de B (et la carte de B saute) | code, à confirmer en E2E | fd66ab4d |
| P2 | G2-1 | Export `.redview` d'un projet partagé : emporte les .fit de **tous** les membres (données de santé, art. 9) et leurs commentaires (identifiants, noms, mentions), sans distinction | code | d74e4328 93f74530 |
| P2 | G3-1 | Feuille de route, aller-retour : un point inséré en tirant le tracé sur la descente est placé avant le sommet (km 7,2 → 2,8), même famille que D1-1 ; touche aussi l'outil de déplacement et le visualiseur LiDAR (`lidarViewerRouteEdit.ts:104`, confirmé en H2) | test | 92ec17b2 |
| P2 | H2-1 | Visualiseur LiDAR, mesure de surface : un polygone qui se recoupe (nœud papillon de 5 000 m²) donne 0 m² en plan et au sol, alors que les parts de pente comptent les deux lobes | test | 1e7e56af |
| P3 | A1-3 | Changement d'e-mail : sonde d'existence de compte (409) | code | c09f6d4a |
| P3 | A1-4 | Inscription d'un tiers bloquable 24 h | code | 45a2fb1d 91fb80ac |
| P3 | A2-1 | Essai gratuit renouvelable en supprimant puis recréant son compte | code | décision produit / juridique attendue |
| P3 | A2-2 | Ligne `subscriptions` recréée après une suppression de compte (course webhook) | code, à confirmer | b7c70aa0 |
| P3 | A2-3 | URL de retour Stripe : tout sous-domaine de redview.tech, en http aussi | code | 3c1282d6 |
| P3 | A3-2 | `fit-status` répond pour des identifiants de .fit hors du projet | code | 371eff24 |
| P3 | A4-1 | Quota général de 120 requêtes/min par IP pour toute l'API (long recalcul, NAT) | à mesurer | d9309780 |
| P3 | A5-1 | Quota Météo-France épuisable par une IP, appels hors du domaine AROME | code | ab1fc77d |
| P3 | A5-2 | Nominatim : un créneau par seconde pour toute l'app, monopolisable | code | 66027498 |
| P3 | A6-1 | Route de révocation du temps réel publique, limiteur global consommé avant la signature | prod (401) | d2c35d6f |
| P3 | A6-2 | Lectures Appwrite avant vérification du jeton, cache d'accès vidé par un anonyme | code | d2c35d6f |
| P3 | A7-1 | Nom d'auteur de commentaire choisi par l'auteur, affiché après son départ | code | ac05b2dc |
| P3 | A8-2 | Texte arbitraire affiché comme erreur sur l'écran de connexion (hameçonnage) ; un échec OAuth y affiche du JSON brut | code + sources Appwrite | 141fdd88 |
| P3 | A10-1 | Export « Vos données » sans les .fit déposés dans les projets des autres | code | 1cfa1fd2 4bb9e06e |
| P3 | A10-2 | Ajout de .fit : le sélecteur ne s'ouvre plus si consentement + réseau dépassent ~5 s (Chromium) ; non reproduit dans le WebKit de Playwright | test (Playwright) | f732ca9f (à vérifier sur un vrai Safari macOS) |
| P3 | A11-2 | URL de fichiers Météo-France sans contrôle d'hôte (SSRF de second ordre) | code | ab1fc77d |
| P3 | A11-3 | E-mail de facturation : portail Stripe et app se contredisent | code | d41ee88c (config Stripe mise à jour au prochain appel du portail ou par `billing:setup`) |
| P3 | A12-1 | Radar OPERA : images absentes jamais mises en cache, 600 appels S3/min relayables par IP | code | be895078 |
| P3 | A13-1 | Codes de vérification et verrous anti-force brute perdus à chaque déploiement (`/tmp` du conteneur) | code | 45a2fb1d (reste : volume Coolify sur `/app/data`) |
| P3 | A14-1 | Suppression de compte : la purge parcourt **tous** les fichiers de tous les comptes (3 buckets) avant de répondre ; le délai nginx de 60 s (prod) sera dépassé quand le service grandira → 504 affiché comme un échec alors que la suppression continue | prod (nginx, comptages) | 730ec710 cf350749 a2289911 4655f36b |
| P3 | A14-3 | « Veuillez patienter Ns avant de redemander un code » jamais traduit (message serveur à nombre variable) | code | 45a2fb1d |
| P3 | A14-4 | Retirer un éditeur : un clic, sans confirmation (sa session est coupée net) | code | f6f52fdc |
| P3 | A16-2 | Aucun enregistrement CAA sur redview.tech | prod (DNS) | à faire hors code : enregistrement CAA |
| P3 | G1-1 | GlitchTip : les fils d'Ariane gardent les `console.warn/error` avec leurs arguments (noms de .fit et de .redview), et l'erreur « projet illisible » cite un extrait du document | code | e5ed1015 |
| P3 | H1-1 | Graphique, axe « heure » = départ + temps écoulé : décalé d'1 h après le changement d'heure du 25/10 (famille B4-1) | code | 1858ec98 |
| P3 | B1-3 | `creator` avec apostrophe perdu, analyseur GPX de repli incomplet | test | 00de53d4 |
| P3 | B2-2 | Nom saisi avec une plage de numéros (« 12-14 rue ») : horaires perdus | test | 77e73e06 |
| P3 | B3-4 | Session expirée : modifications en attente non gardées localement | code | 5b4eb6cf |
| P3 | B4-2 | Sans prédiction, l'horloge de passage oublie les pauses | code | 855e0942 |
| P3 | B4-3 | Date/heure de départ hors bornes acceptées (31/02 25:99 → 4 mars) | test | 8819d405 |
| P3 | B5-2 | Caches de tuiles du SW sans limite, quota partagé avec les projets | code | 11b8ed5f |
| P3 | C1-2 | Un résultat de fond se rattache à la dernière étape d'annulation du même itinéraire, même ancienne ou causée par un autre éditeur | code | 363954d3 |
| P3 | C2-3 | Visualiseur LiDAR : fichier OPFS vide laissé après un échec d'écriture (quota), la copie CacheStorage est alors effacée à la lecture | code | a9b58ab3 |
| P3 | C2-4 | Visualiseur LiDAR : quota plein sans OPFS → pas de `StorageFullError`, l'utilisateur n'est pas prévenu | code | a9b58ab3 |
| P3 | C3-2 | Facturation : bulle « Reprenez d'abord votre abonnement » affichée aussi en cas d'incident de paiement | code | 201170f6 |
| P3 | C3-3 | Pop-in de résiliation sans piège de focus (a11y) | code | 201170f6 |
| P3 | C3-4 | Commentaire qui renvoie à un hook inexistant | code | 91a5be06 |
| P3 | C4-2 | Autres actions à la souris seulement (durée de pause dans l'agenda, renommer une tuile LiDAR, choisir une trace dans le visualiseur) | balayage + code | 15fe34ad |
| P3 | D3-3 | Nom de projet > 255 caractères : refus Appwrite affiché « trop volumineux (30 Mo) », sauvegarde automatique suspendue | code | cdfd7546 |
| P3 | E3-1 | Commentaires : réponse en cours perdue quand l'auteur supprime le fil (carte fermée, lot rejeté sans message) | code | 2131fe2f |
| P3 | E3-2 | Commentaires : état lu/non lu écrit en bloc dans la vue, dernière écriture gagne → fils redevenus « non lus » entre deux appareils | code | 65ce5d97 da83c261 |

## Méthode

1. **Cartographier** la zone : points d'entrée (routes, gestionnaires, événements), données qui y entrent, frontières de confiance.
2. **Hypothèses** par famille : entrée hostile ou mal formée, course / concurrence, état partiel après échec, frontière (0, vide, max, fuseau, unités), droits (IDOR, rôle), fuite d'information (énumération, messages d'erreur, journaux), ressources (mémoire, délais, boucles), cohérence entre adaptateurs (dev / prod), i18n / a11y.
3. **Prouver** : lecture du code jusqu'à la ligne fautive, puis reproduction (test Vitest jetable, script dans le scratchpad, requête). Un constat non prouvé est marqué « à confirmer ».
4. **Noter** : sévérité, fichier:ligne, scénario concret (entrée → sortie fausse), correctif proposé.

Sévérités : **P0** faille / perte de données / panne · **P1** bug fonctionnel visible · **P2** cas limite, robustesse · **P3** qualité, dette.

## Zones

| # | Zone | Session | État |
|---|------|---------|------|
| A1 | Auth : inscription, code, mot de passe oublié, changement d'e-mail, suppression du compte | A | fait : 1 P1, 1 P2, 2 P3 |
| A2 | Facturation Stripe : routes, webhook, idempotence | A | fait : 3 P3 |
| A3 | Partage de projets + droits (`projectSharing`, `project-access`) | A | fait : 1 P2, 1 P3 |
| A4 | Adaptateurs HTTP (`server.mjs`, `http-security`, plugin de dev) : chemins, limites, en-têtes, parité | A | fait : 1 P3 à confirmer |
| A5 | Proxys amont (`brouter`, `poi`, `openmeteo`, `weather`, `meteofrance`, `snow-context`, `pointcloud`, `geocode-iconic`) | A | fait : 2 P3 (`snow-context` survolé) |
| A6 | Serveur temps réel : connexion, auth, révocation | A | fait : 2 P3 |
| A7 | Serveur temps réel : validation des lots (`model/validate.ts`, `commentRules.ts`) | A | fait : 1 P3 |
| A8 | Client : session, liens d'auth (réinitialisation, retour OAuth) | A | fait : 1 P2, 1 P3 |
| A9 | Pages publiques et en-têtes (CSP, `security.txt`) | A | fait : aucun constat |
| A10 | E-mails transactionnels, export « Vos données », consentement santé | A | fait : 1 P2 à confirmer, 1 P3 |
| A11 | `snow-context`, statistiques, portail Stripe | A | fait : 1 P2, 2 P3 |
| A12 | Permissions Appwrite, serveur POI, démon météo, radar | A | fait : 1 P3 |
| A13 | Écrans d'authentification, amorçage, images Docker | A | fait : 1 P3 (+ A8-2 confirmé) |
| A14 | Compte, déconnexion, partage côté interface, délais de bout en bout | A | fait : 1 P2, 3 P3 |
| A15 | Dépendances (`npm audit`), secrets exposés au navigateur, méthodes d'auth et buckets Appwrite, XSS, FreeCam | A | fait : 1 P1, 2 P2 |
| A16 | DNS et e-mail (SPF, DKIM, DMARC, CAA), CORS | A | fait : 1 P2, 1 P3 |
| A17 | TLS, cohérence avec le site vitrine | A | fait : 1 P2 |
| A18 | Outil d'exposition avalanche (visualiseur LiDAR) | A | fait : aucun constat |
| B* | Voir le fichier de la zone B | B | |

## Constats

### A1 — Auth

**A1-1 · P1 · « Mot de passe oublié » : 10 demandes par heure pour tout le service, épuisables par n'importe qui**
- `api/auth/forgot-password.ts:56` appelle `POST /account/recovery` d'Appwrite **depuis le serveur, sans clé d'API**. Appwrite limite cette route par deux clés : `url:{url},email:{param-email}` **et** `url:{url},ip:{ip}`, 10 par heure (`app/controllers/api/account.php`, identique en 1.6.x, 1.8.x et `main`).
- L'`{ip}` que voit Appwrite est celle du serveur de l'app, pas celle du visiteur. Chaîne : app → `https://appwrite.redview.tech` → nginx de l'hôte (`X-Forwarded-For $proxy_add_x_forwarded_for`) → Appwrite, qui garde le saut non fiable le plus à droite (`src/Appwrite/Utopia/Request.php` `getIP`). Tous les utilisateurs partagent donc **un seul compteur de 10 réinitialisations par heure**.
- Scénario : un attaquant (ou simplement 10 personnes dans l'heure) envoie 10 `forgot-password` avec des adresses quelconques. Le quota `auth` de server.mjs l'autorise (15/min par IP). Pendant l'heure qui suit, toute demande reçoit le message neutre « un lien vous a été envoyé », mais aucun e-mail ne part. Le 429 est seulement écrit dans la console, et volontairement pas envoyé à GlitchTip (le commentaire suppose un 429 « par adresse »). La panne est donc silencieuse et totale.
- Preuve : sources d'Appwrite (labels `abuse-key`, `getIP`) + config nginx `server/vps/nginx-appwrite.conf:56`. Pas reproduit en prod : le test priverait les vrais utilisateurs de réinitialisation pendant une heure. Les journaux du conteneur de l'app ne contiennent aucune ligne `forgot-password` depuis son démarrage.
- Correctif proposé : appeler la récupération avec la clé d'API (les requêtes à clé sautent la limitation anti-abus), ou l'envoyer nous-mêmes (`users.createToken`/lien maison + Resend). Ajouter alors notre propre quota par adresse (`consumeVerificationRequestQuota` sur une clé `recovery:<email>`). Envoyer aussi un 429 inattendu à GlitchTip. À vérifier au passage : toute autre route Appwrite appelée sans clé depuis le serveur et limitée par `{ip}`.

**A1-2 · P2 · Changement d'e-mail : adresse changée, mais l'interface affiche un échec**
- `api/auth/change-email.ts:140` : `users.updateEmailVerification` n'est pas protégé. S'il échoue après `userAccount.updateEmail`, la route répond 500 « Impossible de changer l'adresse e-mail », alors que l'adresse a bien changé et que le code est déjà consommé.
- Conséquences : la nouvelle adresse reste non vérifiée, et le partage exige un compte vérifié. Un nouvel essai répond « C'est déjà l'adresse de votre compte ». Stripe et l'avis à l'ancienne adresse sont sautés.
- `verify-code.ts` traite le même appel dans un try/catch avec un commentaire qui explique pourquoi ; `change-email` ne le fait pas. Correctif : même try/catch, puis continuer la synchro Stripe et l'avis.

**A1-3 · P3 · Changement d'e-mail : sonde d'existence de compte**
- `change-email.ts:111` répond 409 « Cette adresse est déjà utilisée par un autre compte ». N'importe quel compte connecté peut donc savoir si une adresse a un compte RedView (5 essais par heure et par compte), alors que l'inscription et le mot de passe oublié sont conçus contre l'énumération.
- Correctif : réponse neutre (« code envoyé ») et e-mail « un compte existe déjà » à la cible, comme à l'inscription. Ou bien accepter et documenter.

**A1-4 · P3 · Inscription : blocage de 24 h de l'inscription d'un tiers**
- Sans authentification, `send-verification-code` pour victime@x crée un code. Cinq mauvais codes l'invalident, un second code (après 30 s) plus cinq autres mauvais essais font 10 échecs : verrou de 24 h sur la clé de l'adresse (`verificationStore.ts` `pushFailure`). La victime ne peut plus s'inscrire par e-mail pendant 24 h et a reçu deux e-mails non sollicités. Cela ne touche que les adresses sans compte.
- Compromis courant ; une piste serait de compter les échecs par IP plutôt que par adresse cible.

### A2 — Facturation

Vérifié sans constat : propriété de chaque objet fourni par le client (`seti_`, `sub_`, `pm_`) comparée au client Stripe du compte ; verrou par client sur `start` / `activate` ; idempotence de l'essai (clé `redview-trial-<seti>`) ; webhook signé, relivraisons dédoublonnées, refus attendus acquittés.

**A2-1 · P3 · Essai gratuit renouvelable en supprimant puis recréant son compte**
- L'éligibilité est calculée par client Stripe (`isTrialEligible(listCustomerSubscriptions(customerId))`). La suppression du compte supprime le client Stripe (`accountDeletion.ts` `deleteBilling`). Une réinscription avec la même adresse et la même carte obtient un client neuf, donc 7 nouveaux jours.
- Coût pour l'abuseur : il perd ses projets, ce qui limite l'intérêt. Correctif possible : garder l'empreinte de la carte (`card.fingerprint`) ou un hachage de l'adresse dans le registre `account_deletions`, et refuser l'essai sur une correspondance. À signaler dans les CGU.

**A2-2 · P3 · Ligne `subscriptions` recréée après la purge d'un compte (course, à confirmer)**
- Ordre de `deleteAccount` : client Stripe supprimé (étape 2), puis… `subscriptions` supprimées, puis `customers` (étape 6). La suppression du client déclenche `customer.subscription.deleted`. Si le webhook arrive entre l'effacement des `subscriptions` et celui de `customers`, `getUserIdFromCustomer` trouve encore le compte et `upsertSubscription` recrée la ligne : il reste une donnée après une suppression RGPD.
- Fenêtre étroite (quelques ms). Correctif simple : effacer `customers` **avant** `subscriptions`, ou faire ignorer par le webhook un compte marqué `deletionpending` ou absent.

**A2-3 · P3 · URL de retour de Stripe : tout sous-domaine de redview.tech, en http aussi**
- `api/_lib/billing/http.ts:5` accepte `^https?://(sous-domaine.)*redview.tech`. Un sous-domaine oublié (DNS pendant après la suppression du site vitrine, prise de contrôle de sous-domaine) deviendrait une destination de redirection depuis le portail Stripe.
- Correctif : liste exacte (`app.redview.tech` + hôtes de dev hors production), comme `forgot-password.ts`.

### A3 — Partage de projets

Vérifié sans constat : propriété établie par les `$permissions`, équipe toujours `p<projectId>`, équipe préexistante recréée au premier partage, verrou par projet, invités vérifiés et actifs, quotas d'invitation par compte et par IP, les identifiants de fichiers venus du document ne sont suivis que vers des fichiers déjà lisibles par le propriétaire.

**A3-1 · P2 · RGPD : les .fit des autres éditeurs survivent à la suppression d'un projet partagé**
- `deleteProject` (client, `projectRows.ts:741`) n'efface que les .fit de l'utilisateur, avec ses droits. Le commentaire l'assume : « ceux des autres éditeurs restent à eux ». `deleteLocked` côté serveur (`projectSharing.ts`), qui a la clé admin, n'efface aucun .fit.
- Scénario : un éditeur importe sa sortie (traces GPS + fréquence cardiaque, données de santé au sens de l'art. 9). Le propriétaire supprime le projet. Le fichier reste indéfiniment, rattaché à aucun projet. L'éditeur ne le voit nulle part, et seul « effacer les .fit du compte » ou la suppression de son compte l'atteint.
- Correctif : `deleteLocked` efface les .fit référencés par le document (lecture comme `ensureShared` : `fitFileIds` + charge utile), avec la clé admin, après avoir vérifié l'appartenance au projet (permission `team:p<id>`). Sinon, documenter que `fit-orphans.ts --apply` est passé régulièrement.

**A3-2 · P3 · `fit-status` répond pour n'importe quel identifiant de .fit**
- `missingFitFiles` vérifie que l'appelant est membre du projet, mais pas que les identifiants appartiennent à ce projet. On peut donc tester l'existence de fichiers .fit d'autres comptes (60 demandes × 200 identifiants toutes les 10 min). Les identifiants sont aléatoires, l'intérêt est faible.
- Correctif : intersecter avec `fitFileIds(document)`, ou exiger la permission `team:p<id>` sur le fichier trouvé.

### A4 — Adaptateurs HTTP

Vérifié sans constat : chemins décodés une fois puis refusés sur `..`, `.`, `\`, `\0` ; routes `/api` résolues sur une liste figée au build (prod), sans `_lib` ; plafond du corps avant mise en mémoire (413) ; quota choisi d'après la route **résolue** ; IP client = entrée de `X-Forwarded-For` la plus à droite derrière un pair privé, `CF-Connecting-IP` cru seulement depuis Cloudflare ; requête à prototype nul ; `.map`/`.br`/`.gz` jamais servis ; 404 sur un asset absent (pas de repli SPA) ; message d'erreur interne masqué en production ; arrêt propre sur SIGTERM.

**A4-1 · P3 · Quota général de 120 requêtes/min par IP pour toute l'API (à confirmer)**
- BRouter, POI, `share`, `geocode`, `billing/overview`… partagent le seau `general` (`server.mjs:107`). Un recalcul complet d'un parcours de 1 200 km fait environ 20 tronçons fins (ancres serrées tous les 60 km), plus les secours `hedge`, plus les couloirs POI, plus l'Open-Meteo. Ajoutez un club ou une entreprise derrière une même IP (NAT) : un 429 devient plausible en usage normal.
- À mesurer : nombre de requêtes `/api/*` d'un recalcul de 1 200 km, avec la recherche POI ensuite, puis vérifier ce que l'app affiche sur un 429 de `/api/brouter` (nouvel essai ? message ?). Piste : un seau `routing` à part, comme `weather` et `pointcloud`.

### A5 — Proxys amont

Vérifié sans constat : BRouter (paramètres en liste blanche, nom de profil borné, `add_beeline` refusé en GET, identifiant de profil = empreinte du contenu, file bornée et secours sans attente, erreurs jamais en cache) ; POI (corps revalidé et réécrit, catégories non vides, bornes ; `limit` borné côté serveur POI) ; nuages de points (hôtes et chemins exacts, redirections refusées, `Range` assaini, flux par client bornés) ; Open-Meteo (chemin exact, modèle en liste blanche, jours et nombre de points bornés) ; météo (chemin en liste de caractères, repli local confiné) ; Nominatim (1 requête/s pour toute l'app, cache de 24 h).

**A5-1 · P3 · `meteofrance` : quota Météo-France épuisable, appels hors du domaine AROME**
- Chaque emprise nouvelle (arrondie au centième de degré, donc presque chaque lieu) coûte un `GetCoverage` sur la clé Météo-France (`api/meteofrance.ts:150`). Aucune vérification que l'emprise est dans le domaine AROME : une emprise en Espagne du Sud ou en Pologne part quand même chez Météo-France et échoue.
- Le quota `general` (120/min par IP) dépasse celui du portail Météo-France (de l'ordre de 50 appels/min par clé). Une seule IP peut donc priver tout le monde du mode neige (502).
- Correctif : refuser hors du domaine AROME 0,01° (400 ou 204, sans appel amont) ; limiter les emprises nouvelles par IP (quelques-unes par minute) ; envisager une grille de cache plus grossière (cellules de 0,5° découpées côté serveur).

**A5-2 · P3 · `geocode-iconic` : un seul créneau Nominatim par seconde pour toute l'app**
- Voulu (politique Nominatim). Mais une IP qui envoie 2 recherches distinctes par seconde (dans son quota de 120/min) occupe la file, et tous les autres reçoivent 503, donc pas de lieux emblématiques. Un créneau réservé pour une requête dont le client est parti pendant l'attente est perdu (`req.socket?.destroyed` après la réservation).
- Piste : un quota par IP propre à cette route (quelques requêtes/min) ; rendre le créneau quand le client part.

### A6 — Serveur temps réel

Vérifié sans constat : jeton vérifié **avant** l'acceptation de la socket, droits relus sans cache, refus codés par un second serveur WebSocket ; origine, ouvertures par IP, connexions par IP et par utilisateur, authentifications en cours et tas plafonnés ; un jeton d'un compte bloqué est refusé par Appwrite (403 = refus de jeton, pas panne) ; relève du jeton par le même utilisateur seulement ; seau de messages et seau d'octets par client, plafond de décompression ; trames binaires seulement après `welcome` ; cache partagé des instantanés indexé par `epoch:seq` avec un `epoch` = `randomUUID()` par chargement de salle (deux salles ne peuvent pas se le partager) ; 404 sans type d'Appwrite (proxy qui redémarre) jamais pris pour un projet supprimé.

**A6-1 · P3 · `/multiplayer/internal/access-changed` joignable publiquement, avec un quota global**
- Le nginx de l'hôte relaie tout `/multiplayer/` (`server/vps/nginx-multiplayer.conf`), et `routeOf` retire le préfixe : la route de révocation est donc publique. Elle est signée (HMAC), donc infalsifiable, mais son limiteur est **une seule clé pour tout le monde** (`allowInternal('internal')`, 300/min, `server/multiplayer/server.ts:205`), consommée **avant** la vérification de la signature.
- Scénario : une IP envoie 10 POST/s (limite nginx) de corps invalides. Le quota de 300/min est vide et les vraies révocations de l'API de partage reçoivent 429. Un éditeur retiré garde la main jusqu'à la revérification périodique (≤ 15 s + cache de 10 s).
- Preuve (prod, 2026-10-10) : `curl -X POST https://app.redview.tech/multiplayer/internal/access-changed -d '{}'` → **401** (réponse de la vérification de signature du serveur temps réel, donc la route est bien atteinte).
- Correctif : `location /multiplayer/internal/ { return 404; }` dans nginx (l'app joint le serveur temps réel en interne), et limiteur par IP, compté seulement après une signature invalide.

**A6-2 · P3 · Avant toute vérification du jeton, lectures Appwrite pour un utilisateur et un projet choisis par l'appelant**
- `server.ts` lance `checkAccess(claimed, projectId, { fresh: true })` sur l'utilisateur que le JWT **déclare**, en parallèle de la vérification (optimisation d'entrée). Un JWT forgé, de la bonne forme mais à signature fausse, déclenche : `account.get` (refusé), la ligne du projet et l'appartenance à l'équipe (clé admin). Le `fresh` vide en plus le cache d'accès de ce projet (`storage.forgetAccess`).
- Rien ne fuit (aucune réponse ne dépend de ces lectures), mais chaque ouverture anonyme coûte 3 appels Appwrite, dans la limite de 60 ouvertures/min par IP et 256 authentifications en cours. Amplification modeste, à garder en tête.
- Piste : ne pas vider le cache (`fresh`) tant que le jeton n'est pas vérifié ; ou ne lancer la lecture anticipée qu'après le premier succès d'un jeton de ce même utilisateur (cache des jetons).

### A7 — Validation des lots du temps réel

Vérifié sans constat :
- **Forme des lots** : lot refusé en entier ; formes canoniques des identifiants et des clés ; racine protégée ; clés vérifiées contre le schéma ; valeurs bornées (profondeur, nœuds, taille, pas de `__proto__`) ; champs typés (nom, couleur, `id` = clé de liste, coordonnées) ; segments de tracé recalculés (empreinte, JSON canonique) et non référencés écartés.
- **Commentaires** : listes de clés fermées ; auteur = auteur du lot à la création ; réactions `~<utilisateur>` ; résolution au nom de l'auteur du lot.
- **Piste écartée** : une création `c` sous un parent qui n'existe pas encore échappe aux contrôles de clés et aux règles des commentaires. Mais `applyOp` l'ignore (pas de parent → aucun effet), sur le serveur comme chez les clients et au rejeu du journal : impossible d'y glisser un message au nom d'un autre.

**A7-1 · P3 · Nom d'auteur d'un commentaire choisi par son auteur, affiché quand il n'est plus membre**
- `authorName` est écrit par le client (≤ 200 caractères, aucun contrôle de contenu, `commentRules.ts`). L'interface préfère le nom du compte tiré de la liste des membres (`CommentToolContext.tsx:90` `nameOf`) et ne retombe sur `authorName` que pour un auteur absent de cette liste : éditeur retiré, compte supprimé, ou commentaires venus d'un `.redview` importé.
- Scénario : un éditeur écrit avec `authorName = "Victor (propriétaire)"`, puis quitte le projet ou en est retiré. Ses messages s'affichent désormais sous ce nom.
- Correctif : n'accepter que `authorName` = nom de présence connu du serveur (le serveur le connaît : `identity.name`), ou afficher « Ancien éditeur » pour un auteur hors membres.

### A8 — Session côté client

(Données locales d'un appareil partagé entre deux comptes : confiées à la zone B3.)

**A8-1 · P2 · Page de connexion inutilisable par un simple lien : `?message=` avec un « % »**
- `src/features/auth/components/login/useAuthUrlParams.ts:37` décode deux fois : `decodeURIComponent(params.get('message'))`. `URLSearchParams.get` a déjà décodé. Une valeur qui contient un `%` (ex. « 100 % ») fait lever `URIError: URI malformed` dans l'effet. `GlobalErrorBoundary` remplace alors toute l'app par l'écran d'erreur. L'URL n'est pas nettoyée (le `replaceState` vient après), donc un rechargement retombe dessus.
- Preuve : `node -e` avec `?message=Paiement%20refus%C3%A9%20%C3%A0%20100%25` → `get` donne `Paiement refusé à 100%`, puis `decodeURIComponent` → **URIError**. `https://app.redview.tech/?message=%25` suffit.
- Touche aussi un vrai retour d'erreur OAuth (`?error=`) dont le texte contiendrait un `%`.
- Correctif : retirer le `decodeURIComponent` (ou le protéger par un try/catch), et nettoyer l'URL avant tout traitement.

**A8-2 · P3 · Texte arbitraire affiché comme message d'erreur sur la page de connexion (hameçonnage)**
- Même fichier : tout `?message=` ou `?error=` s'affiche tel quel dans l'encadré d'erreur de l'écran de connexion officiel (texte échappé par React, pas de XSS). Exemple de lien piégé : `app.redview.tech/?message=Compte suspendu, appelez le 01 23 45 67 89`.
- Correctif : n'afficher que des codes d'erreur connus (`?error=oauth_failed`…) traduits par l'app, jamais du texte venu de l'URL. Confirmé par les sources d'Appwrite (`app/controllers/api/account.php`, `failureRedirect`) : un échec OAuth revient avec `?error={"message":…,"type":…,"code":…}`, et l'écran de connexion affiche **ce JSON brut** à l'utilisateur.

### A10 — E-mails et données du compte (RGPD)

Vérifié sans constat : chaque valeur interpolée dans le HTML des e-mails passe par `escapeHtml` (nom, dates, montants, formule, adresse masquée) ; le nom n'apparaît jamais dans un objet d'e-mail ; aucun e-mail n'est envoyé à un tiers avec un texte choisi par un autre utilisateur (le partage n'envoie pas d'invitation par e-mail).

**A10-1 · P3 · Export « Vos données » incomplet**
- `exportAccountData` (`projectBrowser/account/lib/accountData.ts:111`) exporte le compte, les dossiers, les projets **possédés** et la liste « partagés avec moi ». Il manque des données que le compte a lui-même fournies :
  - les .fit qu'il a importés dans les projets partagés d'autres personnes (données de santé, dont il reste propriétaire dans le bucket) ;
  - ses commentaires dans ces projets ;
  - ses vues `project_views`.
- Le droit d'accès (art. 15) et la portabilité (art. 20) portent sur les données qu'il a fournies. Les .fit sont le cas le plus net.
- Correctif : ajouter `fit-partages/` (fichiers du bucket dont il est propriétaire, hors de ses projets) et, au minimum, mentionner les commentaires dans le LISEZMOI.

**A10-2 · P3 (rétrogradé après test) · Ajout de .fit : le sélecteur de fichiers peut ne pas s'ouvrir après une attente réseau**
- `useFitFileHandlers.ts:50` : `ensureHealthDataConsent()` puis `input.click()`. Entre le clic et l'ouverture du sélecteur, il peut y avoir :
  - un aller-retour Appwrite si l'état du consentement a plus de 5 min (`loadHealthDataConsent`) ;
  - après « J'accepte », deux allers-retours (`updateAccountPrefs` : relecture + écriture).
- Le commentaire affirme que le clic sur « J'accepte » garde l'activation utilisateur. C'est vrai 5 s dans Chrome, mais WebKit ne la garde qu'environ 1 s à travers un `fetch` (ingénieur WebKit, bug 225559 ; billet « The User Activation API » de WebKit). Au-delà, `input.click()` est ignoré sans erreur : rien ne s'ouvre, sans aucun message. Les MacBook sont un public cible de l'app.
- Test (Playwright, page minimale : clic → `fetch` retardé → `input.click()`, 2026-10-10) : Chromium ouvre jusqu'à 3 s d'attente et **bloque à 6 s** ; Firefox et le WebKit de Playwright ouvrent même à 6 s. Le WebKit de Playwright sous Windows n'est pas Safari pour macOS : la limite d'environ 1 s citée par WebKit reste à vérifier sur un vrai Mac. Risque réel mais limité aux réseaux très lents ; rétrogradé de P2 à P3. Correctif : après l'accord, rendre la main à l'utilisateur (« Choisir les fichiers » dans la pop-in, qui ouvre le sélecteur dans son propre clic), et ouvrir directement le sélecteur quand l'accord est déjà connu, sans attendre la relecture.

### A11 — Neige, statistiques, portail Stripe

Vérifié sans constat : statistiques (`beforeSend.ts`) — URL réduite à l'écran virtuel, seuls `utm_*`/`ref` gardés, referrer réduit à son origine, `identify` et `id` supprimés, rien pour un compte interne, données d'événement passées au garde vie privée ; mesures arrondies.

**A11-1 · P2 · `snow-context` : une IP anonyme peut saturer le processeur du serveur de l'app**
- La route n'exige pas de connexion. Pour un lieu nouveau, elle fait jusqu'à 9 appels à `geo.api.gouv.fr` (centre + 8 points sur un cercle), puis télécharge et lit **en entier** le fichier horaire de chaque département trouvé (`mfDepartment`, `api/snow-context.ts:201`).
- Mesure (2026-10-10, scratchpad `mfparse.mjs`) : département 74 = 16,5 Mo compressés, 640 079 lignes, **1,2 s de CPU** pour la seule lecture ligne à ligne, dans le processus unique de l'app.
- Le cache des départements ne garde que **24 entrées** (3 h) pour environ 96 départements. Une IP qui fait tourner ses coordonnées sur la France vide donc le cache en continu. Chaque requête coûte alors plusieurs secondes de CPU et ~16 Mo de téléchargement par département, dans la limite de 120 requêtes/min par IP du seau `general`. Toutes les autres routes de l'API ralentissent.
- Hors convention aussi : `TtlCache` compte des entrées, pas des octets (CLAUDE.md : tout cache serveur en mémoire passe par `byte-lru.mjs`), et le cache météo garde 128 historiques de 60 jours.
- Correctif :
  - un seau de quota propre aux routes neige (quelques lieux nouveaux par minute et par IP), ou exiger une session ;
  - précalculer côté serveur une seule table nationale « dernière NEIGETOT par station », rafraîchie toutes les heures par un minuteur, au lieu de relire un fichier par requête ;
  - `byte-lru` pour les caches.

**A11-2 · P3 · `snow-context` : l'URL des fichiers vient des métadonnées data.gouv.fr sans contrôle d'hôte**
- `mfLatestFiles` ne vérifie que la fin du chemin (`/H_<dép>_latest-AAAA-AAAA.csv.gz`), puis le serveur télécharge cette URL. Une métadonnée de jeu de données modifiée ou compromise ferait appeler par notre serveur n'importe quel hôte, y compris interne (SSRF de second ordre).
- Correctif : liste d'hôtes (aujourd'hui `meteofrance.s3.sbg.io.cloud.ovh.net`, relevé à l'instant) et `https:` imposé.

**A11-3 · P3 · Adresse de facturation : deux sources de vérité**
- Le portail Stripe permet de modifier l'e-mail du client (`customer_update.allowed_updates: ['email', …]`, `api/_lib/billing/portal.ts`). L'app garde sa propre préférence (`customers.billing_email_mode`/`billing_email`) et réécrit l'e-mail Stripe à chaque changement d'adresse du compte (`change-email.ts` `syncStripeCustomerEmail`, mode `account`).
- Scénario : l'utilisateur met sa comptabilité comme adresse dans le portail. Plus tard, il change l'adresse de son compte : l'e-mail Stripe est écrasé sans prévenir, et ses reçus repartent vers lui. L'onglet Abonnement n'a jamais affiché le choix fait dans le portail.
- Correctif : retirer `email` des champs modifiables dans le portail (l'app a son propre réglage), ou relire `customer.email` dans la vue d'ensemble et l'adopter comme `alternative`. Au passage, l'adresse « alternative » n'est jamais vérifiée : des reçus Stripe peuvent partir vers l'adresse d'un tiers.

### A12 — Permissions Appwrite, microservices du VPS

Vérifié sans constat :
- **Collections et buckets** : `documentSecurity`/`fileSecurity` partout, collections sans `read("users")` (création seule pour `projects`, `project_views`, `project_folders`, aucune permission de collection pour `customers`, `subscriptions`, `project_journal`, `account_deletions`).
- **Fausses lignes** : une ligne `user_id` = autrui rendue lisible par tous est écartée à la lecture (`isOwnDocument` pour les dossiers, `access.ts` pour les projets, `listOwnCloudView` pour les vues). L'identifiant déterministe d'une vue squatté par un autre compte se replie sur un autre identifiant (`writeConflictedCloudView`).
- **Serveur POI** : toutes les requêtes SQL sont paramétrées (listes `IN (?, …)` construites à partir du nombre d'éléments seulement).
- **Démon météo** : écoute locale, pas de listage de répertoire, `alias` nginx sans piège de barre oblique (`location /weather/` + `alias …/weather/`).

**A12-1 · P3 · Radar OPERA : une image absente n'est pas mise en cache, chaque demande refait un appel amont**
- `operaFrameFromPath` accepte n'importe quel horodatage `AAAAMMJJTHHMM` (`server/lib/opera-radar.mjs:42`). `frameHeader` lit l'en-tête du COG chez CloudFerro, et un échec (image hors des 24 h du bucket, minute qui n'existe pas) n'est pas gardé. Avec 600 tuiles/min par IP (seau `tiles:radar`), une IP fait relayer par notre serveur jusqu'à 600 requêtes S3 par minute vers des objets absents.
- Correctif : refuser un horodatage hors de la liste `listOperaFrames()` (déjà en cache 1 min), ou garder l'échec quelques minutes.

### A13 — Écrans d'authentification, amorçage, images Docker

Vérifié sans constat :
- **Lien de réinitialisation** : jetons retirés de l'URL et de l'historique tout de suite ; session courante fermée (anti-fixation).
- **Sessions après un changement de mot de passe** : un changement ou une réinitialisation ferme les autres sessions par défaut (`invalidateSessions ?? true` sur `PATCH /account/password` et `PUT /account/recovery`, sources d'Appwrite `main`). À confirmer une fois dans la console (Auth → Security) que l'option n'a pas été désactivée.
- **Inscription** : code réutilisé tant qu'il est valable au lieu d'en redemander un ; compte déjà créé mais session non ouverte (réseau) → nouvel essai par simple connexion.
- **Amorçage** : 401 confirmé → connexion, Appwrite injoignable → hors ligne si une session locale existe, sinon « Réessayer » ; cache TanStack vidé à chaque changement de compte. Dans un onglet resté ouvert sous le compte A alors qu'un autre onglet s'est connecté en B, les écritures échouent : Appwrite refuse qu'une session B accorde des droits à `user:A`, donc rien ne passe d'un compte à l'autre.
- **Images Docker** : bases épinglées par empreinte, utilisateur non root, `.env`/clés exclus du contexte, tests et CI hors de l'image.

**A13-1 · P3 · Codes de vérification et verrous anti-force brute perdus à chaque déploiement**
- `verificationStore.ts` persiste dans `os.tmpdir()` (`/tmp` du conteneur), effacé à chaque nouvelle image. Un déploiement pendant une inscription donne « Aucun code trouvé, demandez-en un nouveau ». Les compteurs d'échecs et les verrous de 24 h repartent aussi de zéro (inscription, suppression de compte, changement d'e-mail).
- Correctif : un volume Coolify pour ce fichier, ou les codes dans une collection Appwrite (hachés, avec expiration).

### A14 — Compte, déconnexion, délais de bout en bout

**A14-1 · P3 · Suppression de compte : la purge dépassera le délai nginx quand le service grandira**
- `deleteAccount` (`api/_lib/accountDeletion.ts`) parcourt **tous les fichiers de tous les comptes** des trois buckets (`deleteOwnedFiles` : pages de 100, puis tri par permissions), puis supprime chaque projet possédé (plusieurs appels Appwrite chacun), **avant** de répondre.
- Le client attend 180 s (`DELETE_ACCOUNT_TIMEOUT_MS`), mais le nginx de l'hôte coupe à **60 s** (`/etc/nginx/conf.d/app.conf`, `location /` : `proxy_read_timeout 60s`, lu en prod) et `server.mjs` à 120 s.
- Aujourd'hui : 70 miniatures, 100 .fit, 12 charges, 434 projets (comptage en lecture seule, 2026-10-10), donc rapide. Avec quelques milliers de comptes, un compte à beaucoup de projets dépassera 60 s : 504, l'écran affiche « La suppression du compte a échoué », alors que la purge continue côté serveur. Un nouvel essai tombe sur « Aucun code trouvé » ou sur une session refusée (compte déjà bloqué).
- Correctif : répondre 202 dès le blocage et l'inscription au registre, puis purger en tâche de fond (le code de reprise existe déjà : `finishDeletionLater`) ; lister les fichiers du compte par requête plutôt qu'en parcourant tout le bucket.

**A14-2 · P2 · « Se déconnecter » peut laisser la session ouverte : on se retrouve connecté au rechargement**
- `signOutAccount` (`projectBrowser/account/lib/profile.ts:302`) fait la course entre `account.deleteSession('current')` et un délai de **1,5 s**, ignore toute erreur, efface le `cookieFallback` local, puis l'appelant recharge la page (`useProjectBrowserOverlayState.ts:346`). Ce rechargement interrompt la révocation encore en cours.
- Or la vraie session est le cookie `httpOnly` d'Appwrite (`appwrite.redview.tech`, même site que l'app), que le JavaScript ne peut pas effacer. Au rechargement, `hasStoredAppwriteSession()` est faux, mais `resolveInitialAppwriteSession` interroge quand même Appwrite (`App.tsx` : « sans snapshot, on attend Appwrite »). Le cookie toujours valide rouvre la session.
- Scénario : ordinateur partagé ou réseau lent (révocation > 1,5 s, p95 Appwrite mesuré à 650 ms en charge), ou déconnexion hors ligne. L'utilisateur clique « Se déconnecter », voit l'écran de connexion… et la personne suivante qui recharge (ou lui-même plus tard) est connectée sur son compte.
- Correctif : attendre la révocation (avec un délai plus long et un message d'échec : « Déconnexion impossible : vérifiez votre connexion »), ne recharger qu'après son succès ; hors ligne, refuser la déconnexion ou la mettre en file pour le retour du réseau.

**A14-3 · P3 · « Veuillez patienter Ns avant de redemander un code » jamais traduit**
- Message du serveur à nombre variable (`verificationStore.ts` `consumeVerificationRequestQuota`, 1 à 30 s), affiché tel quel par l'inscription (« Renvoyer le code »), le changement d'e-mail et la suppression du compte. Aucune paire dans `translations/` : le traducteur du DOM ne reconnaît que des textes entiers, donc un utilisateur anglophone le voit en français. Les messages `Code invalide (N essai(s) restant(s))` ont été traités en énumérant N = 1…4 (`auth.ts:82`) ; celui-ci a été oublié.
- Correctif : renvoyer un code d'erreur et la durée (`{ error: 'cooldown', retryAfter: 23 }`), traduits par l'écran avec `t('Veuillez patienter {{seconds}} s…')`.

**A14-4 · P3 · Retirer un éditeur se fait en un clic, sans confirmation**
- `ShareProjectDialog.tsx:220` : le bouton × d'un membre appelle `remove.mutate` tout de suite. Le serveur temps réel est prévenu et ferme sa session (4403) au milieu de son travail. Partir du projet, en revanche, demande une confirmation (`leaveProjectDialog`).
- Correctif : `confirmDialog` « Retirer X du projet ? », comme pour le départ.

### A15 — Dépendances, secrets exposés au navigateur

Vérifié sans constat : `npm audit` (2026-10-10) → 0 vulnérabilité connue, dépendances de prod comme de dev, et pour le serveur POI ; variables `VITE_*` = valeurs publiques par nature (point d'accès et projet Appwrite, clé publiable Stripe, DSN Sentry, jeton public Mapbox) ; gitleaks sur tout l'historique en CI ; aucune XSS dans les popups construits en chaînes HTML (`poi-popup.ts`, `popupHtml.ts`, visualiseur LiDAR : chaque valeur venue d'OSM, d'une saisie ou d'un co-éditeur passe par `escapeHtml`, le reste = nombres et constantes) ; présence du temps réel (nom imposé par le serveur, champs filtrés et bornés) ; FreeCam (touches relâchées sur `blur`/`visibilitychange`, garde de sortie de page levée avec Cmd).

**A15-1 · P2 · Jeton Mapbox de production sans restriction d'URL**
- Le jeton public (`pk.…`) est forcément lisible dans le JavaScript (chunk de l'éditeur, retrouvé en 4 requêtes depuis `https://app.redview.tech/`). Mapbox recommande de le **restreindre aux URL** de l'app. Test (2026-10-10) : `GET https://api.mapbox.com/styles/v1/mapbox/streets-v12?access_token=<jeton de prod>` → **200** sans `Referer`, et **200** avec `Referer: https://evil.example.com/`.
- Conséquence : n'importe quel site peut utiliser notre jeton pour afficher des cartes Mapbox. Chargements de carte et tuiles facturés sur notre compte, quotas consommés, et en cas d'abus massif, un jeton révoqué en urgence casse la carte de RedView pour tout le monde.
- Correctif (compte Mapbox, aucune ligne de code) : URL autorisées `https://app.redview.tech/*` et les hôtes de dev (`http://localhost:*` sur un jeton de dev distinct) ; vérifier ensuite l'export vidéo et le visualiseur LiDAR (`/viewer`), qui envoient le même `Referer`. Mettre en place une alerte de consommation dans Mapbox.

**A15-2 · P2 · Inscription directe par l'API Appwrite, sans code de vérification**
- Le parcours d'inscription prévu passe par notre serveur : code à 6 chiffres, quotas, compte créé par la clé admin (`verify-code.ts`). Mais `POST /v1/account` d'Appwrite reste ouvert aux clients. Sonde sans effet (mot de passe trop court) : `400 general_argument_invalid` (« Password must be between 8 and 256 characters »), et non un refus de méthode. La création de compte et la connexion par mot de passe partagent le même interrupteur (`auth.type = email-password`, `account.php` lignes 308 et 1012) : on ne peut pas fermer l'une sans casser l'autre.
- Et l'app ne vérifie jamais `emailVerification` (aucune lecture dans `src/` hors export RGPD). Pendant la bêta ouverte, tout compte a accès à tout.
- Scénario : un script crée des comptes avec des adresses quelconques, y compris celle d'un tiers, sans posséder la boîte. Il utilise l'app (routage, POI, météo : nos quotas amont) sans passer par les quotas de `send-verification-code`. Le vrai propriétaire de l'adresse reçoit ensuite « un compte existe déjà » ; il peut le reprendre par « mot de passe oublié » (P1 A1-1 : peut-être pas pendant l'heure en cours).
- Atténuations existantes : le partage refuse les invités non vérifiés ; l'essai exige un moyen de paiement.
- Correctif : traiter un compte `emailVerification = false` comme non inscrit (écran « confirmez votre adresse » avec envoi d'un code), côté app **et** côté API (`requireAuthenticatedUser` → 403 pour les routes coûteuses). En bonus : désactiver dans la console les méthodes inutilisées. Les sondes équivalentes sur Magic URL, OTP par e-mail et téléphone répondent aussi par une erreur de paramètre : elles sont probablement activées (valeur par défaut d'Appwrite), donc n'importe qui peut faire envoyer des liens de connexion par notre domaine. À confirmer et à fermer dans Auth → Settings (et Anonymous).

**A15-3 · P1 · N'importe quel compte peut remplir le disque du VPS par envoi direct de fichiers**
- Les trois buckets accordent `create("users")` (`scripts/appwrite/setup-appwrite-schema.mjs`), avec une taille maximale par fichier (10 Mo, 30 Mo, 30 Mo) et un contrôle d'extension seulement (`.fit`, `.gz`, images). Mais **aucun plafond par compte ni au total**, et le contenu n'est pas vérifié : n'importe quels octets nommés `x.gz` passent.
- Limite d'Appwrite : 60 envois par heure et par (IP, utilisateur, morceau) (`storage.php`, `abuse-limit = APP_LIMIT_WRITE_RATE_DEFAULT`), soit **~1,8 Go/h par compte et par IP** en fichiers de 30 Mo. Avec A15-2 (comptes créés librement) et quelques IP, le débit se multiplie.
- Disque de prod (2026-10-10, lecture seule) : 83 Go, **32 Go libres**. Le même disque porte Appwrite, MariaDB, les dumps de sauvegarde, Coolify, GlitchTip, Umami et BRouter : plein, tout tombe (incident du 08/10 à 97 % : ~45 min de dégradation). Les fichiers ne sont rattachés à aucun projet et ne sont jamais purgés automatiquement (`fit-orphans.ts` est manuel). Chaque nuit, la sauvegarde restic les envoie en plus sur Google Drive.
- Correctif :
  - retirer `create("users")` des buckets et faire passer les envois par une route serveur qui contrôle quota par compte, propriété du projet et contenu (en-tête FIT, magie gzip) ;
  - à défaut, un minuteur serveur qui purge les fichiers orphelins de plus de 24 h et alerte au-delà de N Go par compte ;
  - ajouter au contrôle de surveillance une alerte de disque plus précoce que 90 %.
- Même famille côté base : `projects` accepte aussi `create("users")`, avec un `data` jusqu'à ~12 M caractères par ligne (limite nginx devant Appwrite). Cela fait remplir MariaDB, et les dumps nocturnes, au rythme des écritures permises par Appwrite (à mesurer). À traiter avec le même quota par compte.

### A16 — Domaine et e-mail (DNS)

Vérifié sans constat :
- **CORS** : seules les tuiles météo et de repli (données publiques) ont `Access-Control-Allow-Origin: *`. Les routes authentifiées attendent un `Bearer` (pas de cookie), donc pas de CSRF ; les routes publiques en JSON imposent une requête préalable (preflight) depuis un autre site.
- **Envoi des e-mails** : SPF de `send.redview.tech` (Amazon SES de Resend) et DKIM `resend._domainkey` publiés.
- **Console Appwrite** : `https://appwrite.redview.tech/console` répond 404.

**A16-1 · P2 · DMARC en `p=none` : n'importe qui peut envoyer des e-mails « @redview.tech »**
- `_dmarc.redview.tech` = `v=DMARC1; p=none;` (relevé le 2026-10-10), sans `rua` : aucune consigne de rejet aux messageries, et aucun rapport reçu. Le SPF de la racine (`include:spf.improvmx.com ~all`) est en échec souple.
- Pour un SaaS qui envoie codes de vérification, résiliations et rappels de prélèvement, un faux « Votre paiement a échoué, mettez à jour votre carte » au nom de `facturation@redview.tech` passera les filtres de nombreuses messageries.
- Correctif (DNS, sans code) : ajouter `rua=mailto:…` pour recevoir les rapports, vérifier 2 à 4 semaines que tous les envois légitimes (Resend, Appwrite si son SMTP est distinct, ImprovMX) sont alignés, puis passer à `p=quarantine` puis `p=reject`.

**A16-2 · P3 · Aucun enregistrement CAA**
- `redview.tech` n'a pas de CAA : n'importe quelle autorité de certification peut émettre un certificat pour le domaine. Correctif : `CAA 0 issue "letsencrypt.org"` (l'autorité réellement utilisée par le nginx de l'hôte, à vérifier) et `iodef` vers l'adresse de contact.

### A17 — Cohérence avec le site vitrine

Vérifié sans constat : TLS 1.0/1.1 refusés, 1.2/1.3 acceptés (`app.redview.tech`) ; HSTS, CSP et `X-Frame-Options: DENY` présents sur les pages de prod.

**A17-1 · P2 · Le site vitrine annonce d'autres prix que l'app**
- Ce que montre l'app :
  - formules Stripe à 14,90 €/mois, 70 €/6 mois, 119 €/an, avec 7 jours d'essai (`api/_lib/billing/plans.ts`) ;
  - liens vers les offres du site vitrine : `https://redview.tech/pricing` (`App.tsx:131`) et `…/#offres` (`useProjectBrowserOverlayState.ts:539`).
- Ce qu'affiche `https://redview.tech/pricing` (relevé le 2026-10-10) : « 0 € (Gratuit Bêta) », « Paiement unique de 5 € · Soutien au développement indépendant », « Dès 15 € (Don libre) ». Ni abonnement, ni durée, ni essai, ni reconduction tacite.
- Pour la personne qui compare avant de s'abonner, c'est une information précontractuelle contradictoire sur le prix (art. L.111-1 et L.121-2 C. conso : pratique commerciale trompeuse sur le prix). C'est aussi une source de réclamations (« on m'avait dit 5 € une fois »).
- Correctif : aligner la page des offres sur `plans.ts`, ou retirer les liens de l'app tant que la page n'est pas à jour. La règle de la maison est de ne jamais modifier le site depuis ce dépôt : décision et mise à jour côté site.

### A18 — Exposition au terrain avalancheux (visualiseur LiDAR)

Vérifié sans constat : un terrain raide qui se prolonge au-delà du bord de la zone chargée est signalé (`exposure.ts`, `EDGE_SLOPE_DEG`), au lieu de conclure « non avalancheux » ; libellé « d'après le terrain, pas la neige » ; avertissement des CGU (§ 3 : estimations, ne remplacent ni le BRA ni le jugement sur le terrain).

### A9 — Pages publiques et en-têtes

Vérifié sans constat : CSP sans `unsafe-inline` ni `unsafe-eval` pour les scripts, `frame-ancestors 'none'`, `object-src 'none'`, `form-action 'self'`, rapport des violations vers GlitchTip ; HSTS avec préchargement, `nosniff`, `Referrer-Policy`, `Permissions-Policy` ; `security.txt` servi en `text/plain` (prod vérifiée), `Expires` 2027-10-09. Les champs légaux « [à compléter] » sont connus et suivis ailleurs (décision de l'utilisateur).

## Zones vérifiées sans constat

_(au fil de l'eau)_

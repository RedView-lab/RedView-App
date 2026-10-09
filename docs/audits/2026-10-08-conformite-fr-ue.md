# Audit de conformité France / Union européenne — 2026-10-08

Périmètre : l'application web RedView (`app.redview.tech`) telle qu'elle est dans
ce dépôt le 8 octobre 2026 — comptes (Appwrite auto-hébergé), projets enregistrés
dans le cloud, fichiers FIT, co-édition et commentaires dans les projets
partagés, statistiques anonymes (Umami auto-hébergé), carte Mapbox, e-mails
transactionnels Resend, erreurs GlitchTip auto-hébergé, VPS Oracle Cloud,
sauvegardes chiffrées sur Google Drive.

**Ce document n'est pas un avis juridique.** Il relève, pour chaque obligation,
la source officielle, ce que fait le code aujourd'hui et l'écart constaté. Les
textes proposés (mentions légales, politique de confidentialité, CGU, registre,
déclaration d'accessibilité) sont des **brouillons à faire valider par un
juriste** avant toute publication ; aucun n'est en production.

La facturation (Stripe, abonnements) est **gelée** : elle n'a pas été modifiée,
ses écarts sont seulement signalés (§ 9).

## Sommaire

1. [Synthèse](#1-synthèse)
2. [Tableau des exigences](#2-tableau-des-exigences)
3. [Inventaire des traitements et des destinataires](#3-inventaire-des-traitements-et-des-destinataires)
4. [Inventaire des traceurs (cookies, stockage local)](#4-inventaire-des-traceurs-cookies-stockage-local)
5. [Durées de conservation constatées](#5-durées-de-conservation-constatées)
6. [Correctifs faits dans ce lot](#6-correctifs-faits-dans-ce-lot)
7. [Brouillons de textes (à valider)](#7-brouillons-de-textes-à-valider)
8. [Questions à trancher par l'utilisateur ou un juriste](#8-questions-à-trancher-par-lutilisateur-ou-un-juriste)
9. [Facturation (gelée) : écarts signalés](#9-facturation-gelée--écarts-signalés)
10. [Sources](#10-sources)

## 1. Synthèse

Le socle technique est bon : export et suppression du compte déjà en place
(`projectBrowser/account/`, `api/_lib/accountDeletion.ts`), statistiques sans
cookie, sans `identify` ni replay, conservées 25 mois (`server/vps/umami/retention.sql`),
erreurs nettoyées avant envoi (`shared/lib/errorReportScrub.ts`), journaux sans
URL ni corps de requête (`server/lib/request-logging.mjs`), coordonnées des
itinéraires BRouter gardées 48 h seulement, sauvegardes chiffrées, polices
servies par l'app (plus d'appel à Google Fonts).

**Il manque en revanche toute la couche d'information et d'encadrement
juridique visible par l'utilisateur.** Aucune page ni aucun lien n'existe pour :
les mentions légales (obligation pénale, LCEN art. 1-1), la politique de
confidentialité (RGPD art. 13), les conditions d'utilisation (DSA art. 14), le
point de contact et le signalement de contenus (DSA art. 12 et 16), la
déclaration d'accessibilité. Ce sont les écarts les plus graves, et ils
demandent des textes juridiques et des informations que seul l'éditeur peut
fournir (identité, adresse, directeur de la publication).

Trois points demandent une décision de fond :

1. **Fichiers FIT et fréquence cardiaque** — *traité depuis* (`3960889`, voir § 2.2) : des données de santé au sens de
   l'article 9 du RGPD sont probablement traitées (fréquence cardiaque, parfois
   puissance et cadence). Il faut un consentement explicite distinct, ou ne pas
   conserver ces champs.
2. **Traceur Mapbox** : la bibliothèque Mapbox GL JS écrit un identifiant
   aléatoire dans le `localStorage` (`mapbox.eventData*`) et l'envoie à
   `events.mapbox.com` (États-Unis) pour ses statistiques d'usage. Ce n'est pas
   un traceur exempté au sens de la CNIL ; consentement ou désactivation à
   arbitrer avec les conditions de Mapbox.
3. **Transferts hors UE** : Mapbox, Resend et Google sont américains ; le cadre
   EU-US Data Privacy Framework (validé par le Tribunal de l'UE le 3 septembre
   2025) les couvre s'ils y sont certifiés — à vérifier et à documenter, ainsi
   que la région de l'instance Oracle.

## 2. Tableau des exigences

Gravité : **Bloquant** (sanction pénale ou manquement direct à une obligation
d'information de base) · **Élevé** (manquement exposant à une sanction CNIL /
DGCCRF / Arcom) · **Moyen** (à corriger rapidement, risque limité) · **Faible**
(bonne pratique, recommandation) · **Info** (à titre informatif).

Qui décide : **Dev** (correctif technique sans ambiguïté) · **Éditeur**
(information ou décision produit que seul le titulaire du service peut donner) ·
**Juriste** (texte ou qualification juridique).

### 2.1 Information et mentions obligatoires

| Exigence | Source | État actuel (code) | Écart | Gravité | Action proposée | Qui décide |
|---|---|---|---|---|---|---|
| Mentions légales : identité de l'éditeur (nom ou raison sociale, adresse, téléphone, e-mail, n° RCS/SIREN, capital, directeur de la publication) et de l'hébergeur (nom, adresse, téléphone), accessibles directement | LCEN art. 1-1 (créé par la loi SREN n° 2024-449 du 21/05/2024, ex-art. 6 III) ; sanction art. 1-2 : 1 an et 75 000 € (personne physique), 375 000 € (personne morale) | Aucune page, aucun lien. `index.html`, `LoginScreen.tsx`, `ProjectBrowser` : rien | Totalement absent | **Bloquant** | Page « Mentions légales » (brouillon § 7.1) liée depuis l'écran de connexion et le menu du compte. Hébergeur : Oracle (VPS) pour l'app et Appwrite | Éditeur (identité) + Juriste |
| Information des personnes au moment de la collecte (identité du responsable, finalités, bases légales, destinataires, transferts, durées, droits, réclamation CNIL) | RGPD art. 12 et 13 | Aucune politique de confidentialité ; l'écran d'inscription (`features/auth/components/LoginScreen.tsx`) collecte nom, e-mail, mot de passe ou connexion Google sans aucune information | Absent | **Bloquant** | Politique de confidentialité (brouillon § 7.2), lien sous le formulaire d'inscription et dans « Compte » | Juriste + Éditeur |
| Information sur la mesure d'audience (même exemptée de consentement) | CNIL, « Cookies : solutions pour les outils de mesure d'audience » (mise à jour 04/07/2025) | Umami sans cookie, 25 mois ; aucune information visible | Information absente → **corrigé** (2026-10-09, `5d8d708`, `66ca041`) : politique de confidentialité § 2 et § 9 (`/confidentialite`), interrupteur « Mesure d'audience » dans les Réglages (opposition, `umami.disabled`) | Élevé → corrigé | Relecture du texte par un juriste | Juriste |
| Conditions générales d'utilisation claires, accessibles, décrivant les restrictions d'usage et la modération | DSA art. 14 (règlement (UE) 2022/2065, applicable depuis le 17/02/2024) ; Code de la consommation (information précontractuelle, art. L. 111-1) | Aucune | Absent → **corrigé** (2026-10-09, `5d8d708`) : CGU publiques (`/cgu`, modération et signalement § 5), mention « en créant un compte, vous acceptez… » à l'inscription, liens dans la connexion et les Réglages | Élevé → corrigé | Relecture du texte par un juriste | Juriste + Éditeur |

### 2.2 Données personnelles (RGPD)

| Exigence | Source | État actuel (code) | Écart | Gravité | Action proposée | Qui décide |
|---|---|---|---|---|---|---|
| Registre des activités de traitement | RGPD art. 30 (l'exemption < 250 salariés ne joue pas pour un traitement non occasionnel) | Aucun registre ; l'inventaire technique existe en creux (`CLAUDE.md`, `docs/analytics/measurement.md`) | Absent | **Élevé** | Registre (brouillon § 7.4, à partir du § 3) | Éditeur |
| Base légale pour chaque traitement | RGPD art. 6 | Non documentée | À formaliser → **corrigé** (2026-10-09, `5d8d708`) : finalité et base légale de chaque traitement dans la politique de confidentialité § 2 | Élevé → corrigé | Relecture par un juriste ; traceur Mapbox toujours à trancher (§ 2.3) | Juriste |
| Données de santé : fréquence cardiaque, puissance, cadence et trace GPS des fichiers FIT | RGPD art. 9 § 1 et 2 a) — consentement explicite | **Traité** (décision de l'utilisateur, `3960889`) : pop-in d'accord explicite et distincte (`shared/components/HealthDataConsent/`) avant tout import — sélecteur de .fit (accord avant d'ouvrir le sélecteur, donc aucun fichier lu sans lui), import d'un `.redview` et duplication d'un projet (refus → sans leurs .fit) ; accord versionné dans les préférences du compte (`prefs.healthDataConsent = { version, acceptedAt }`, donc dans l'export RGPD) avec miroir local ; retrait dans « Compte → Vos données », avec effacement des .fit dont le compte est propriétaire ; vérifié par `e2e:journey` (refus → aucun sélecteur ouvert) | Les .fit reçus d'un autre éditeur dans un projet partagé restent lus (accord donné par leur auteur) ; le texte dit « sur les serveurs de RedView » tant que la région n'est pas confirmée | Faible | Compléter la phrase « Où » de la pop-in quand la région sera confirmée (puis augmenter `HEALTH_DATA_CONSENT_VERSION`) | Éditeur |
| Suppression des FIT quand un projet ou un itinéraire est supprimé (limitation de la conservation) | RGPD art. 5 § 1 e) et art. 17 | `deleteProjectFitFiles` et `deleteProjectItineraryFitFiles` étaient vides (`TODO(rgpd)` dans `fitFiles.ts`) : seule la suppression du compte purgeait les orphelins | Constaté — **corrigé par la session de contrôle** en `241f507` (suppression d'un projet → ses FIT effacés ; itinéraire supprimé → FIT effacé à la fermeture du projet s'il n'est plus référencé, l'annulation reste possible ; duplication corrigée). Reste ouvert : les FIT orphelins **déjà présents en production** (suppressions passées) | Élevé → corrigé pour l'avenir ; orphelins existants : Moyen | Comptés en production par `scripts/appwrite/fit-orphans.ts` (`f4da3e5`, lecture seule) : 196 fichiers FIT dans le bucket, 9 référencés, **96 orphelins de plus de 7 jours (72,7 Mio)** ; purge avec `--apply` à décider | Dev (script) + Éditeur (purge) |
| Droits d'accès, de portabilité, d'effacement | RGPD art. 15, 17, 20 | Faits : « Compte → Vos données » (ZIP complet), suppression du compte confirmée par code e-mail, purge idempotente (`api/_lib/accountDeletion.ts`), registre `account_deletions`, réapplication après restauration (`scripts/appwrite/account-deletions.ts`) | Conforme ; le délai de 12 mois dans les sauvegardes doit être annoncé | Faible | Le mentionner dans la politique de confidentialité | Juriste |
| Droits de rectification, d'opposition, de limitation ; contact pour exercer les droits | RGPD art. 12, 16, 18, 21 | Rectification du nom et de l'e-mail dans le compte ; aucune adresse de contact publiée | Contact absent → **corrigé** (2026-10-09, `5d8d708`) : adresse de contact (`redview.app@proton.me`, `LEGAL_PUBLISHER.contactEmail`) dans la politique § 7, les mentions légales et `/.well-known/security.txt` ; changement d'adresse e-mail dans le compte | Élevé → corrigé | Une adresse au domaine de RedView quand elle existera | Éditeur |
| Contrats de sous-traitance (DPA) | RGPD art. 28 | Non documentés dans le dépôt | À vérifier | **Élevé** | Signer / archiver les DPA : Oracle (hébergement), Mapbox, Resend, Google (Drive, connexion Google), Stripe (gelé), Rainviewer si les requêtes passent par le navigateur. Les outils auto-hébergés (Appwrite, Umami, GlitchTip) ne sont pas des sous-traitants | Éditeur |
| Transferts hors UE | RGPD art. 44-49 ; décision d'adéquation (UE) 2023/1795 (EU-US DPF), validée par le Tribunal de l'UE le 03/09/2025 (T-553/23, Latombe) | Mapbox (le navigateur appelle directement `api.mapbox.com` et `events.mapbox.com` : adresse IP, zone consultée), Resend (adresses e-mail, codes), Google (connexion OAuth ; Drive : blocs chiffrés seulement) | Non documentés | **Élevé** | Vérifier l'inscription de chaque société sur dataprivacyframework.gov (Mapbox et Resend s'annoncent certifiés) ; à défaut, clauses contractuelles types + analyse d'impact du transfert ; mentionner les transferts dans la politique | Éditeur + Juriste |
| Localisation de l'hébergement principal | RGPD art. 44 (si hors EEE) | VPS Oracle `141.145.220.99` ; région non indiquée dans le dépôt | À confirmer | Moyen | Confirmer la région OCI (EEE ?) et l'entité contractante ; l'indiquer dans les mentions et la politique | Éditeur |
| Sécurité du traitement | RGPD art. 32 | HSTS, CSP stricte (`server/lib/csp.mjs`), limitation de débit, journaux sans données personnelles, sauvegardes chiffrées et testées chaque semaine, surveillance (`server/vps/watch/`) | Bon niveau ; pas de politique de mots de passe documentée côté Appwrite, pas d'authentification à deux facteurs proposée | Faible | Documenter la politique Appwrite (longueur minimale, limite de sessions) ; envisager la double authentification | Dev |
| Notification des violations à la CNIL sous 72 h, registre des violations, information des personnes en cas de risque élevé | RGPD art. 33 et 34 ; CNIL « Violations de données personnelles : les règles à suivre » | Alertes techniques (`redview-watch`, GlitchTip) mais aucune procédure ni registre | Procédure absente → **procédure écrite** (2026-10-09) : `docs/operations/violation-de-donnees.md` (qui décide, 72 h, téléservice CNIL, information des personnes, modèle de fiche du registre) | Élevé → à mettre en place | Désigner la personne qui décide ; tenir le registre hors du dépôt | Éditeur |
| Mineurs : consentement d'un parent sous 15 ans quand le traitement repose sur le consentement | RGPD art. 8 ; loi Informatique et Libertés art. 45 ; CNIL recommandation 4 (2021) | Aucun âge demandé ; les traitements principaux reposent sur le contrat, pas sur le consentement | Faible pour le contrat ; concerne le consentement santé et Mapbox s'ils sont retenus | Moyen | Âge minimal dans les CGU (p. ex. 15 ans, ou 18 ans si paiement), case « j'ai l'âge requis » à l'inscription | Éditeur + Juriste |
| Analyse d'impact (AIPD) | RGPD art. 35 ; liste CNIL des traitements soumis à AIPD | Localisation (tracés, positions de départ), données de santé possibles, co-édition | À évaluer : deux critères (données sensibles + localisation) peuvent suffire | Moyen | Évaluer le besoin d'une AIPD une fois la décision sur les FIT prise | Juriste |

### 2.3 Traceurs (ePrivacy, art. 82 loi Informatique et Libertés)

| Exigence | Source | État actuel (code) | Écart | Gravité | Action proposée | Qui décide |
|---|---|---|---|---|---|---|
| Consentement préalable pour tout traceur non strictement nécessaire (cookies, `localStorage`, IndexedDB…) | Directive 2002/58/CE art. 5 § 3 ; loi I&L art. 82 ; lignes directrices et recommandation CNIL (2020, mises à jour 2023) | Inventaire § 4 : tous les stockages de l'app sont fonctionnels (session, projets hors ligne, préférences d'affichage), sauf l'identifiant Mapbox | Mapbox `mapbox.eventData*` | **Élevé** | Soit bandeau de consentement limité à Mapbox, soit désactivation des événements si les conditions de Mapbox le permettent (à vérifier contractuellement : ces événements servent à la facturation) | Éditeur + Juriste |
| Exemption de consentement pour la mesure d'audience | CNIL (page mise à jour le 04/07/2025) : finalité limitée à la mesure pour le seul éditeur, statistiques anonymes, pas de recoupement, pas de suivi inter-sites, pas de transmission de données non anonymes à des tiers ; recommandés : 13 mois pour le traceur, 25 mois pour les données, information des utilisateurs | Umami 3.4 auto-hébergé, servi depuis le domaine de l'app (`/s/`), sans cookie, sans `identify` ni replay, valeurs arrondies et catégorisées (`shared/lib/analytics/`), 25 mois (`server/vps/umami/retention.sql`), comptes `internal` exclus | Conforme aux conditions techniques ; information absente ; deux points à documenter : la clé `rv:analytics-context` (contexte de compte arrondi : formule, ancienneté) et l'empreinte de session calculée par Umami | Moyen | Informer (politique de confidentialité) ; proposer un lien d'opposition simple (p. ex. un réglage « Ne pas mesurer ma visite » qui pose `umami.disabled` dans le `localStorage`) | Juriste (texte) + Dev (réglage, après décision) |
| Service Worker, Cache Storage, OPFS | Idem | `public/sw-dem.js` (tuiles de relief), OPFS (tuiles LiDAR téléchargées à la demande) | Strictement nécessaires au service demandé : exemptés | — | Les citer dans la politique (transparence) | — |

### 2.4 Services numériques (DSA) et LCEN

| Exigence | Source | État actuel (code) | Écart | Gravité | Action proposée | Qui décide |
|---|---|---|---|---|---|---|
| Qualification : RedView héberge des contenus fournis par les utilisateurs (projets, commentaires, fichiers) → **service d'hébergement**. Les projets ne sont partagés qu'avec des personnes invitées : pas de diffusion au public, donc a priori **pas une plateforme en ligne** | DSA art. 3 g) iii) et i) | Partage sur invitation par e-mail (`api/projects/share.ts`) ; aucun lien public | Qualification à confirmer | Info | Confirmer la qualification « hébergeur, pas plateforme » | Juriste |
| Point de contact pour les autorités et pour les utilisateurs, électronique, facile d'accès | DSA art. 11 et 12 | Aucun | Absent → **corrigé** (2026-10-09, `5d8d708`) : « Contact et signalement » des mentions légales, langues français et anglais | Élevé → corrigé | — | Éditeur |
| Mécanisme de signalement des contenus illicites, facile d'accès, électronique ; information de l'auteur du signalement ; motivation des décisions | DSA art. 16 et 17 (applicables à tous les hébergeurs, sans exemption pour les petites entreprises) | Aucun moyen de signaler un commentaire ou un projet partagé | Absent → **corrigé** (2026-10-09) : adresse de signalement, délais et motivation dans les CGU § 5 et les mentions légales ; « Signaler » dans le menu de chaque commentaire d'un autre éditeur (e-mail prérempli : auteur, date, identifiant du message, extrait — `comments/lib/reportComment.ts`) | Élevé → corrigé | Reste la procédure de traitement (qui lit, délai, information de l'auteur) | Éditeur (procédure) |
| Conservation des données d'identification des personnes ayant contribué à un contenu (hébergeurs) | LCEN art. 6 ; décret n° 2021-1362 (catégories) et n° 2021-1363 (un an, injonction renouvelée) | Appwrite garde l'identité des comptes ; les journaux applicatifs n'ont pas l'IP ; les journaux nginx de l'hôte ne sont pas versionnés | Durée et contenu non documentés | Moyen | Vérifier la configuration nginx de l'hôte (format, rotation) ; documenter ce qui est gardé et combien de temps ; ne pas garder plus d'un an | Éditeur + Juriste |

### 2.5 Accessibilité

| Exigence | Source | État actuel (code) | Écart | Gravité | Action proposée | Qui décide |
|---|---|---|---|---|---|---|
| Acte européen sur l'accessibilité (EAA) : services de commerce électronique destinés aux consommateurs, applicable depuis le 28/06/2025 ; exemption des microentreprises de services | Directive (UE) 2019/882 ; loi n° 2023-171 du 09/03/2023 (art. 16) ; décret n° 2023-931 et arrêté du 09/10/2023 ; DGCCRF | Le service est gratuit en bêta ; la vente d'abonnements (gelée) en ferait un service de commerce électronique. La taille de l'éditeur (microentreprise ?) n'est pas connue du dépôt | Qualification et exemption à déterminer | Moyen | Si microentreprise : exemption à documenter (démarche DGCCRF « invocation d'une exemption ») ; sinon audit RGAA / EN 301 549 et déclaration d'accessibilité avant l'ouverture des abonnements | Éditeur + Juriste |
| Langue de la page déclarée et juste | RGAA 4.1 critère 8.3 ; WCAG 2.1 critère 3.1.1 | `index.html` déclarait `lang="en"` alors que l'écran de chargement, le titre et la description sont en français ; `AppI18nProvider` corrige l'attribut après le premier rendu React | Langue fausse pendant le chargement (lecteurs d'écran) | Moyen → **corrigé** | `lang="fr"` statique (§ 6) | Dev |
| Taille des cibles interactives | WCAG 2.2 critère 2.5.8 (24 × 24 px minimum) | Le parcours E2E (`e2e:journey`, axe) a relevé des cibles trop petites | **Corrigé par la session de contrôle** en `2db2fb3` (cibles ≥ 24 px) | Moyen → corrigé | — | Dev |
| Audit automatique (axe-core, WCAG 2.0 / 2.1 / 2.2 A et AA) | EN 301 549 § 9 | Parcours E2E bloquant avant chaque déploiement (`script-test-bench/user-journey/`) : **0 défaut sur 10 écrans** — connexion, projets, éditeur, panneau Exporter, outil Tracer armé, mode commentaire, réglages, dialogue de partage, compte, suppression du compte (`a15b559`, `2fc49f0`, `c57b2c1`). Tracer et Commenter atteints et activés au clavier seul, focus visible. Corrigé au passage : contour de focus par défaut des contrôles en `all: unset`, noms accessibles (bouton Enregistrer, listes des réglages), contrastes des métadonnées et des titres de pop-in | L'automatique couvre environ 30 à 40 % des critères RGAA ; restent manuels : alternatives de la carte 3D et du visualiseur LiDAR, ordre de lecture, zoom 200 %, lecteurs d'écran, visualiseur `/viewer` (non audité par axe) | Moyen | Audit manuel RGAA sur ces écrans, audit axe du visualiseur dans `bench:lidar-engines` | Dev + Éditeur |
| Visualiseur LiDAR (`/viewer`) : audit automatique | EN 301 549 § 9 ; WCAG 2.1 A/AA | Audité par axe dans `bench:lidar-engines` (tuile synthétique ; viewer chargé + menu du clic droit), cliquet `script-test-bench/lidar-viewer-engines/a11y-baseline.json`. Premier audit : 10 règles, 53 éléments, **tous corrigés** — sections repliées du panneau de droite `inert` (`Section.tsx`), pastilles de couleur nommées par leur libellé et leur valeur (`ColorPalettePicker`), curseurs nommés (`Slider` exige un `label` ; panneau de gauche lié à ses libellés), navigateur de tuiles en groupe de boutons, menu du clic droit fait d'entrées de menu. **0 défaut**, référence vide : un défaut nouveau bloque | Aucun écart automatique ; restent les contrôles manuels (rendu 3D par nature non textuel, lecteurs d'écran) | Moyen → **corrigé** (automatique) | — | Dev |
| Niveau AA, déclaration d'accessibilité, moyen de contact | RGAA 4.1 ; EN 301 549 | Bonnes bases (`:focus-visible`, `aria-label`, `prefers-reduced-motion` par endroits, `bench:screens`, axe dans `e2e:journey`) ; pas d'audit complet ; carte 3D et visualiseur WebGL par nature difficilement accessibles | Pas d'audit, pas de déclaration | Moyen | Audit RGAA sur les parcours compte, projets, partage ; déclaration (brouillon § 7.5), même volontaire | Éditeur |

### 2.6 Divers

| Exigence | Source | État actuel (code) | Écart | Gravité | Action proposée | Qui décide |
|---|---|---|---|---|---|---|
| Écoconception | RGESN 2024 (Arcep, Arcom, ADEME, 17/05/2024) — volontaire pour une entreprise privée | Budget de chargement initial (`npm run bundle:check`, 300 Kio brotli), précompression, Service Worker, pas de vidéo en lecture automatique | Pas de déclaration | Info | Déclaration d'écoconception facultative (modèle Arcep) | Éditeur |
| Sécurité (recommandations) | ANSSI, guides d'hygiène et de sécurisation des sites web | CSP sans `unsafe-eval`, HSTS preload, en-têtes de sécurité, limitation de débit, audit de sécurité collab (`docs/audits/`) | Conforme aux bonnes pratiques principales | Faible | Pas d'action | — |

## 3. Inventaire des traitements et des destinataires

Base du registre (§ 7.4).

| Traitement | Données | Personnes | Base légale proposée | Où | Destinataires / sous-traitants | Hors UE |
|---|---|---|---|---|---|---|
| Comptes et authentification | nom, e-mail, mot de passe (haché par Appwrite), identifiant Google si connexion Google, sessions | utilisateurs | contrat | Appwrite auto-hébergé, VPS Oracle | Oracle (hébergement) ; Google (OAuth) | Google : oui (DPF à vérifier) |
| Codes de vérification et e-mails de service | e-mail, code, nom | utilisateurs | contrat | `api/auth/*`, `api/_lib/mailer.ts` | Resend | oui (certifié DPF selon Resend, mars 2025) |
| Projets et itinéraires | tracés, points de départ et d'étape (localisation), réglages, commentaires, vignettes | utilisateurs et collaborateurs | contrat | Appwrite (lignes + bucket `project-payloads`), IndexedDB locale | Oracle | selon région |
| Fichiers FIT | traces GPS horodatées, vitesse, puissance, **fréquence cardiaque** | utilisateurs | **consentement explicite (art. 9)**, recueilli avant tout import (`3960889`) | bucket `fit-files` | Oracle | selon région |
| Co-édition en temps réel | identifiant de compte, nom, curseur et vue de la carte (non journalisés), lots d'édition | collaborateurs | contrat | `server/multiplayer/`, journal `project_journal` | Oracle | selon région |
| Carte | adresse IP, zone et niveau de zoom consultés, identifiant `mapbox.eventData` | visiteurs connectés | intérêt légitime (affichage) ; **consentement** pour l'identifiant d'usage | navigateur → Mapbox | Mapbox | oui (certifié DPF selon Mapbox) |
| Autres sources de tuiles et de données appelées par le navigateur | adresse IP, zone consultée | visiteurs | intérêt légitime | navigateur → IGN, swisstopo, AWS (Terrarium), LINZ, GSI… (depuis le 2026-10-09 : plus RainViewer — radar EUMETNET OPERA lu par le serveur de l’app —, plus Esri — remplacé par LINZ) (`server/lib/csp.mjs`) | ces fournisseurs (destinataires, pas sous-traitants) | certains (AWS, Esri, RainViewer) |
| Mesure d'audience | événements anonymes, écrans virtuels, valeurs arrondies, empreinte de session Umami | visiteurs | exemption CNIL (pas de consentement), information | Umami auto-hébergé | aucun | non |
| Erreurs | message d'erreur, chemin de page sans paramètres, navigateur, version | visiteurs | intérêt légitime (fiabilité) | GlitchTip auto-hébergé | aucun | non |
| Journaux techniques | méthode, route normalisée, statut, durée, identifiant de requête (pas d'IP ni d'URL brute) | visiteurs | intérêt légitime (sécurité) | stdout Docker (3 × 10 Mo), journald (30 jours ; BRouter 48 h) | Oracle | selon région |
| Journaux du nginx de l'hôte | adresse IP, URL, agent utilisateur (format par défaut) | visiteurs | intérêt légitime / obligation légale (LCEN) | hôte, non versionné | Oracle | selon région |
| Sauvegardes | copie chiffrée de l'ensemble | tous | intérêt légitime (continuité) | restic → Google Drive (`drive.file`) | Google (blocs chiffrés, sans clé) | oui |
| Facturation (gelée) | identifiant client Stripe, abonnement | abonnés | contrat / obligation comptable | Stripe | Stripe | oui |

## 4. Inventaire des traceurs (cookies, stockage local)

Aucun cookie n'est posé par l'application ; Appwrite peut poser ses propres
cookies de session sur `appwrite.redview.tech` (strictement nécessaires).

| Stockage | Clés ou contenu (relevé dans `src/`) | Finalité | Consentement |
|---|---|---|---|
| `localStorage` — session | `redview:appwrite-session` | garder la connexion | non (strictement nécessaire) |
| `localStorage` — projets hors ligne | `redview:local-projects:v1`, `redview:local-folders:v1`, dossiers par utilisateur, vue en attente | fonctionnement hors ligne | non |
| `localStorage` — préférences | largeurs de panneaux, thème, langue (`redview:project-browser-settings:v1`), pentes, altitude, libellés, profils de routage, formats de coordonnées, état du visualiseur | personnalisation demandée | non |
| `localStorage` — techniques | `redview:app-cache-epoch`, `redview:preload-error-reload-at`, `redview:map-cache-auto-reload`, `redview-lidar-webgpu-retry-at`, `RV_LOG_LEVEL` | fiabilité | non |
| `localStorage` — mesure d'audience | `rv:analytics-context` (formule et ancienneté arrondies), `rv:auth-intent` | mesure d'audience exemptée | non, si les conditions CNIL restent tenues ; à mentionner |
| `localStorage` — **Mapbox** | `mapbox.eventData*` : identifiant aléatoire envoyé à `events.mapbox.com` | statistiques d'usage de Mapbox (facturation) | **oui, en l'état** (§ 2.3) |
| IndexedDB | copie locale des projets (`idbProjectStore`), lots non synchronisés (`redview-collab`) | fonctionnement hors ligne, co-édition | non |
| Service Worker, Cache Storage | tuiles de relief, d'orthophotos, de pentes | performance du service demandé | non |
| OPFS | tuiles LiDAR téléchargées par l'utilisateur, caches dérivés | service demandé | non |
| `sessionStorage` | aucun usage identifié de suivi | — | — |

## 5. Durées de conservation constatées

| Donnée | Durée | Source |
|---|---|---|
| Compte et projets | jusqu'à la suppression par l'utilisateur | `api/_lib/accountDeletion.ts` |
| Compte inactif | **aucune durée** | — à décider (p. ex. suppression après 3 ans d'inactivité, avec un e-mail de prévenance) |
| Sauvegardes | 7 quotidiennes, 5 hebdomadaires, 12 mensuelles : effacement complet au plus tard 12 mois après une suppression | `server/vps/backup/README.md` |
| Statistiques Umami | 25 mois | `server/vps/umami/retention.sql` |
| Journaux Docker | 3 fichiers de 10 Mo par conteneur (rotation) | `server/vps/docker-daemon.json` |
| Journal système | 30 jours, 300 Mo | `server/vps/journald-90-redview.conf` |
| Journal BRouter (coordonnées des requêtes) | 48 h | `server/vps/journald@brouter.conf` |
| Journaux nginx de l'hôte | **non documenté** | à vérifier sur l'hôte |
| Erreurs GlitchTip | non documenté dans le dépôt | à vérifier (réglage de rétention GlitchTip) |
| Codes de vérification | courte durée (`api/_lib/verificationStore.ts`) | — |
| Registre des suppressions de compte | identifiants et dates seulement | `account_deletions` |

## 6. Correctifs faits dans ce lot

Correctifs sans ambiguïté juridique ni décision produit, chacun dans un commit
séparé (voir le message de livraison pour les identifiants).

1. **`index.html` : `lang="fr"`.** La page de démarrage (titre, description,
   écran « Chargement de RedView… ») est en français, et le français est la
   langue par défaut de l'app (`resolveAppLocale` renvoie `fr` sans indication
   contraire). `AppI18nProvider` met toujours l'attribut à jour au premier
   rendu pour un utilisateur anglophone ; `readDocumentAppLocale` retombe donc
   sur la langue par défaut au lieu de l'anglais avant ce rendu. RGAA 8.3 /
   WCAG 3.1.1.

Constaté et corrigé par la session de contrôle : suppression des fichiers FIT
avec le projet ou l'itinéraire (`241f507`, RGPD art. 5 § 1 c et e, § 2.2) ;
taille des cibles interactives (`2db2fb3`, § 2.5).

Hors conformité, à la demande de l'utilisateur : le mode photo du visualiseur
LiDAR a été retiré (`d4acc10`) ; il ne posait pas de question de conformité
(aucune donnée personnelle, pas de traceur propre).

Rien d'autre n'a été modifié dans le code : les autres écarts demandent un
texte juridique, une information que seul l'éditeur détient, ou une décision
(Mapbox, FIT, opposition à la mesure d'audience).

## 7. Brouillons de textes (à valider)

Les passages entre crochets sont à compléter par l'éditeur. **Aucun de ces
textes n'est publié.**

### 7.1 Mentions légales

> **Éditeur** — RedView est édité par [raison sociale ou nom], [forme
> juridique] au capital de [montant] €, immatriculée au RCS de [ville] sous le
> numéro [SIREN], dont le siège est situé [adresse]. Téléphone : [numéro].
> E-mail : [contact@redview.tech]. Numéro de TVA intracommunautaire : [numéro].
>
> **Directeur de la publication** — [prénom, nom], [qualité].
>
> **Hébergement** — Le service est hébergé par Oracle [entité contractante,
> p. ex. Oracle France SAS ou Oracle EMEA], [adresse], [téléphone], sur des
> serveurs situés [région OCI].
>
> **Contact et signalement** — Pour toute question, demande liée à vos
> données ou signalement d'un contenu illicite : [adresse]. Nous répondons en
> français et en anglais.

### 7.2 Politique de confidentialité (plan)

1. Qui est responsable du traitement, comment nous joindre.
2. Ce que nous collectons et pourquoi, avec la base légale (tableau du § 3).
3. Fichiers FIT : contenu, données de santé, consentement, retrait.
4. Carte et fournisseurs de données : ce que votre navigateur transmet à
   Mapbox et aux autres sources de tuiles (adresse IP, zone consultée).
5. Mesure d'audience : outil auto-hébergé, sans cookie, anonyme, 25 mois ;
   comment s'y opposer.
6. Destinataires et sous-traitants ; transferts hors UE et garanties (DPF ou
   clauses contractuelles types).
7. Durées de conservation (§ 5), dont le délai de 12 mois dans les sauvegardes
   après une suppression.
8. Vos droits : accès et portabilité (« Compte → Vos données »), effacement
   (« Supprimer mon compte »), rectification, opposition, limitation ; droit
   d'introduire une réclamation auprès de la CNIL (cnil.fr).
9. Sécurité, et ce que nous faisons en cas de violation de données.
10. Stockage local et traceurs (§ 4).
11. Mineurs.
12. Date de la dernière mise à jour.

### 7.3 Conditions générales d'utilisation (plan)

Objet du service ; accès et âge minimal ; compte et sécurité ; contenus des
utilisateurs (projets, commentaires, fichiers) : licence nécessaire à
l'hébergement et au partage, interdictions, **procédure de signalement et de
modération (DSA art. 14, 16, 17)** ; projets partagés et rôle des invités ;
disponibilité (bêta), limites de responsabilité (les prédictions de temps, la
neige, les avalanches et la météo sont indicatives et ne remplacent pas le
jugement en montagne) ; propriété intellectuelle et licences des données
(OpenStreetMap, IGN, Etalab, swisstopo…) ; suspension et résiliation ;
modification des CGU ; droit applicable, médiation de la consommation
[si applicable], juridiction.

### 7.4 Registre des traitements

Reprendre le tableau du § 3, une fiche par traitement : finalité, catégories de
personnes et de données, destinataires, transferts et garanties, durées (§ 5),
mesures de sécurité (§ 2.2), date de création et de mise à jour. Le tenir hors
du dépôt (document de l'éditeur), le dépôt n'en étant que la source technique.

### 7.5 Déclaration d'accessibilité (modèle)

> [Raison sociale] s'engage à rendre son service accessible. Cette déclaration
> s'applique à app.redview.tech. **État de conformité** : [non conforme /
> partiellement conforme], aucun audit n'ayant encore été réalisé [ou : résultat
> de l'audit du (date)]. **Contenus non accessibles** : la carte 3D et le
> visualiseur LiDAR (WebGL/WebGPU) n'ont pas d'alternative textuelle complète ;
> [autres]. **Retour d'information et contact** : [adresse]. **Voies de
> recours** : [DGCCRF pour un service de commerce électronique ; Défenseur des
> droits].

## 8. Questions à trancher par l'utilisateur ou un juriste

1. Identité juridique de l'éditeur, adresse, directeur de la publication, taille
   de l'entreprise (microentreprise ?) — conditionne les mentions légales et
   l'exemption EAA.
2. Région et entité contractante de l'instance Oracle.
3. ~~Fichiers FIT : consentement explicite au cardio~~ — tranché : consentement explicite (`3960889`). Reste la phrase « Où » de la pop-in, à compléter avec la région confirmée (« sur les serveurs de RedView, [en France / dans l'Union européenne] »). Ancienne alternative : suppression des champs
   physiologiques avant envoi ?
4. Mapbox : bandeau de consentement limité à son identifiant d'usage, ou
   désactivation des événements si le contrat Mapbox le permet ?
5. Mesure d'audience : ajouter un réglage « Ne pas mesurer ma visite » ?
6. Âge minimal d'inscription.
7. Durée de conservation des comptes inactifs.
8. Qualification DSA (hébergeur sans diffusion au public) et procédure de
   signalement.
9. Durée de conservation des journaux nginx de l'hôte et de GlitchTip.
10. Purge des 96 fichiers FIT orphelins en production (`scripts/appwrite/fit-orphans.ts --apply`).

## 9. Facturation (gelée) : écarts signalés

Non modifié. Avant d'ouvrir les abonnements : conditions générales de vente
(prix TTC, durée, renouvellement, résiliation en trois clics — Code de la
consommation art. L. 215-1-1), droit de rétractation de 14 jours et renonciation
expresse en cas d'exécution immédiate (art. L. 221-18 et L. 221-28), médiateur
de la consommation (art. L. 612-1), information précontractuelle
(art. L. 221-5), Stripe comme sous-traitant / destinataire et transfert hors UE,
conservation comptable (10 ans, Code de commerce art. L. 123-22), et
l'Acte européen sur l'accessibilité qui s'applique au parcours d'achat sauf
exemption.

## 10. Sources

Consultées le 2026-10-08.

- RGPD — Règlement (UE) 2016/679 : <https://eur-lex.europa.eu/eli/reg/2016/679/oj>
- Directive ePrivacy 2002/58/CE : <https://eur-lex.europa.eu/eli/dir/2002/58/oj>
- Loi Informatique et Libertés (art. 45, art. 82) : <https://www.legifrance.gouv.fr/loda/id/JORFTEXT000000886460>
- CNIL — Cookies : solutions pour les outils de mesure d'audience (mise à jour du 04/07/2025) : <https://www.cnil.fr/fr/cookies-solutions-pour-les-outils-de-mesure-daudience>
- CNIL — Violations de données personnelles : les règles à suivre : <https://www.cnil.fr/fr/violations-de-donnees-personnelles-les-regles-suivre>
- CNIL — Recommandation 4, consentement d'un parent sous 15 ans (2021) : <https://www.cnil.fr/fr/recommandation-4-rechercher-le-consentement-dun-parent-pour-les-mineurs-de-moins-de-15-ans>
- LCEN — Loi n° 2004-575 (art. 1-1, 1-2, 6), version consolidée : <https://www.legifrance.gouv.fr/loda/id/JORFTEXT000000801164>
- Loi SREN n° 2024-449 du 21/05/2024 : <https://www.legifrance.gouv.fr/jorf/id/JORFTEXT000049563368>
- Décrets n° 2021-1362 et 2021-1363 du 20/10/2021 (données d'identification, conservation d'un an), JO du 21/10/2021 — référence secondaire, à relire sur Légifrance : <https://www.dalloz-actualite.fr/document/decr-n-2021-1362-20-oct-2021-jo-21-oct> ; Conseil d'État, 30/06/2023 : <https://www.conseil-etat.fr/fr/arianeweb/CE/decision/2023-06-30/468361>
- DSA — Règlement (UE) 2022/2065 : <https://eur-lex.europa.eu/eli/reg/2022/2065/oj>
- EU-US Data Privacy Framework — Décision d'exécution (UE) 2023/1795 : <https://eur-lex.europa.eu/eli/dec_impl/2023/1795/oj> ; liste des organisations : <https://www.dataprivacyframework.gov/list>
- Tribunal de l'UE, 03/09/2025, T-553/23, Latombe c/ Commission (commentaire) : <https://www.wsgrdataadvisor.com/2025/09/eu-court-upholds-the-validity-of-the-eu-u-s-data-privacy-framework/>
- Acte européen sur l'accessibilité — Directive (UE) 2019/882 : <https://eur-lex.europa.eu/eli/dir/2019/882/oj>
- DGCCRF — Produits et services conformes à la directive accessibilité : <https://www.economie.gouv.fr/dgccrf/professionnels-vos-produits-et-services-doivent-etre-conformes-la-directive-accessibilite>
- RGAA 4.1 (DINUM) : <https://accessibilite.numerique.gouv.fr/>
- RGESN 2024 (Arcep, Arcom) : <https://www.arcep.fr/actualites/actualites-et-communiques/detail/n/environnement-rgesn-170524.html>
- Mapbox — certification DPF : <https://www.mapbox.com/legal/notice-of-certification> ; stockage local de Mapbox GL JS : <https://github.com/mapbox/mapbox-gl-js/blob/main/STORAGE.md>
- Resend — certification DPF (mars 2025) : <https://resend.com/changelog/data-privacy-framework-certification>
- Umami — FAQ (pas de cookie, pas de donnée identifiante) : <https://umami.is/docs/faq>

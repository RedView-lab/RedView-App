# Violation de données personnelles : que faire

[← Index de la documentation](../README.md) · [Politique de sécurité](../../SECURITY.md) ·
[Sauvegardes et reprise](../../server/vps/backup/README.md) ·
[Surveillance](../../server/vps/watch/README.md)

Procédure courte à suivre quand des données personnelles des utilisateurs ont
pu être lues, copiées, modifiées, perdues ou rendues indisponibles par
quelqu'un qui n'aurait pas dû (RGPD art. 33 et 34). Elle répond à l'écart
« notification des violations » de l'[audit de conformité du
2026-10-08](../audits/2026-10-08-conformite-fr-ue.md) (§ 2.2). À relire par
un juriste ; les décisions restent celles du responsable du traitement.

## Exemples

- Clé d'API Appwrite (`APPWRITE_API_KEY`), Stripe, Resend ou secret du
  serveur temps réel (`MULTIPLAYER_INTERNAL_SECRET`) exposé (commit, capture,
  journal, poste perdu).
- Accès non autorisé à un projet, à un fichier FIT ou à un compte (faille de
  droits, partage détourné, session volée).
- Base Appwrite, sauvegarde restic ou dossier Google Drive `RedView-Restic`
  compromis ; mot de passe restic exposé.
- Perte de données sans sauvegarde utilisable (violation de disponibilité).
- Un sous-traitant (Oracle, Resend, Mapbox, Google, Stripe) annonce une
  violation qui touche nos données.

Les fichiers FIT contiennent des données de santé (fréquence cardiaque :
RGPD art. 9) : une violation qui les touche est en principe à **risque élevé**.

## Qui décide

Le responsable du traitement : l'éditeur (mentions légales, `/mentions-legales`,
`src/features/legal/lib/publisher.ts`). Toute personne qui constate ou reçoit un
signalement (adresse de contact, `/.well-known/security.txt`, GlitchTip,
e-mail « PANNE » de `redview-watch`) le prévient **tout de suite** et note
l'heure : le délai de 72 h court à partir du moment où l'on a connaissance de la
violation, pas de sa cause.

## Chronologie

| Quand | Quoi |
|---|---|
| Tout de suite | Ouvrir une fiche dans le registre (modèle plus bas) : heure de découverte, source, ce que l'on sait. |
| Dans les premières heures | **Contenir.** Révoquer et remplacer chaque secret exposé : console Appwrite (clé d'API, puis variable `APPWRITE_API_KEY` de Coolify), Stripe (clé secrète, secret du webhook), Resend, `MULTIPLAYER_INTERNAL_SECRET` (les deux services Coolify), `METEOFRANCE_API_KEY`, `UMAMI_API_KEY` ; bloquer un compte compromis (Appwrite → Users → Block : la session est refusée partout, `isSessionRejectedError`) ; retirer un partage (`api/projects/share.ts`, le serveur temps réel ferme la session en 4403) ; au besoin, arrêter un service dans Coolify ou revenir à une image saine (`npm run rollback -- <sha>`, voir `CLAUDE.md`). Garder les preuves : ne rien effacer des journaux. |
| Dans les 24 h | **Évaluer.** Quelles données (comptes, projets et itinéraires, FIT, e-mails), combien de personnes, depuis quand, les données sont-elles exploitables (chiffrées ? sauvegardes restic chiffrées : oui), le risque pour les personnes (aucun, risque, risque élevé). Journaux utiles : ligne JSON par requête de l'app (route normalisée, statut, `X-Request-ID`), GlitchTip, journal d'audit d'Appwrite, `/metrics.json` du temps réel. |
| Avant 72 h | **Notifier la CNIL**, sauf si la violation n'engendre vraisemblablement aucun risque pour les personnes (le noter alors dans le registre avec la raison). Téléservice : <https://notifications.cnil.fr/notifications/index>. Une notification initiale incomplète est permise ; on la complète ensuite. Au-delà de 72 h, dire pourquoi. |
| Sans tarder si risque élevé | **Informer les personnes concernées** (art. 34), en termes simples : ce qui s'est passé, les données touchées, les conséquences probables, ce que nous avons fait, ce qu'elles peuvent faire (changer de mot de passe…), le contact. Par e-mail (Resend, adresse de contact en réponse). |
| Après | Corriger la cause, ajouter un test ou un contrôle qui l'aurait détectée, restaurer si besoin (`server/vps/backup/README.md`, puis rejouer les suppressions de compte : `scripts/appwrite/account-deletions.ts --reapply`), compléter la fiche du registre. |

## Registre des violations

Obligatoire pour **toutes** les violations, même celles qui ne sont pas
notifiées (art. 33 § 5). Il contient des données personnelles et des détails de
sécurité : il est tenu **hors du dépôt** (documents de l'éditeur), jamais dans
GitHub. Une fiche par violation :

```text
Date et heure de découverte :
Source (qui / quel outil l'a signalée) :
Nature (confidentialité / intégrité / disponibilité) :
Données concernées (catégories) :
Personnes concernées (catégories, nombre approximatif) :
Conséquences probables :
Mesures prises (heure par heure) :
Risque retenu (aucun / risque / risque élevé) et raison :
Notification CNIL (date, numéro) ou raison de ne pas notifier :
Information des personnes (date, moyen) ou raison de ne pas informer :
Cause et correctif (commit, réglage) :
```

## Sous-traitants

Chaque sous-traitant doit nous prévenir sans délai d'une violation qui touche
nos données (art. 28 § 3 f) et art. 33 § 2) : c'est prévu par leurs accords de
traitement des données (DPA), que l'éditeur signe et archive (audit § 2.2). Une
alerte reçue d'eux suit la même procédure.

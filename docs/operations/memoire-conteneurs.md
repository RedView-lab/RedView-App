# Mémoire des conteneurs Coolify

> Relevé du 2026-10-08 (SSH en lecture seule : `docker inspect`, cgroup,
> `v8.getHeapStatistics()` dans chaque conteneur) et instantanés
> `server-perf/` du 05 au 07/10. Rien n'a été changé en production.

## État actuel

| Conteneur | Rôle | Limite (Coolify) | Swap | Tas V8 auto | RSS observé | Pic cgroup |
|---|---|---|---|---|---|---|
| `q7lznj8fhunybhvuvm3jcu0u` | app (`server.mjs`, port 3000) | **768 MiB** | aucun | 396 MiB | 49–172 Mo | 68 Mo depuis le redémarrage du 08/10 07:52 |
| `krejrvgvs2w5kmfo27rutffz` | temps réel (`multiplayer.mjs`, 17790) | **1,5 GiB** | aucun | 792 MiB | 50–131 Mo (300 Mio le 05/10, avant limite) | 70 Mo depuis le 08/10 07:51 |
| `jsssoodwfi6rvvmvawcg3isq` | site vitrine (`redview-website`, Next.js, 3002) | **aucune** | — | 4 144 MiB (voit l'hôte) | 230 Mo – 1 010 Mio | **1,03 GiB** depuis le 21/09 |

Aucun OOM ni redémarrage (`memory.events` : `oom 0`, `oom_kill 0`).
Node 22 lit la limite du cgroup (`process.constrainedMemory()`) et se donne
un tas d'environ la moitié : un `NODE_OPTIONS=--max-old-space-size` n'apporte
rien tant qu'une limite est posée.

## Budget de l'app (768 MiB)

Caches bornés en octets (`server/lib/byte-lru.mjs`), au plus : réponses
compressées 16 Mio, BRouter 48 Mio, géocodage 4 Mio, Météo-France 32 Mio,
météo 32 Mio, tuiles Terrarium / pente / altitude 32 + 16 + 16 Mio, radar
OPERA 82 Mio (depuis le 2026-10-09, `server/lib/opera-radar.mjs` : en-têtes
2 + tuiles décodées sur un octet par pixel 32 + correspondances de pixels 24
+ PNG 24), soit ≈ 278 Mio, surtout des `Buffer` et tableaux typés hors du tas
V8. Avec ~100 Mo de base et les corps transitoires (compression d'API
jusqu'à 32 Mio, charge de projet ≤ 30 Mo), le pire cas reste sous ~530 Mo :
**768 MiB est suffisant**, marge de ~30 %.

## Budget du temps réel (1,5 GiB)

Une salle tient au plus ~2 × son document (objectif de `bench:collab-load`,
mesuré 1,95 ×), plafond de salle 150 M caractères ; le cache des `welcome`
compressés est borné à 128 Mio ; tampon d'envoi par socket ≤ 32 Mio. Charge
de 250 clients en banc : RSS 315 Mo. **1,5 GiB couvre l'usage actuel** ; un
très gros projet partagé (≥ 100 M caractères, rare) pourrait l'approcher —
la limite fait alors redémarrer le conteneur (reprise = point de reprise +
journal), au lieu de menacer l'hôte.

## Proposition

1. **Site vitrine** : poser une limite de **1,5 GiB** dans Coolify (Resource
   limits → Maximum memory), swap égal. Son tas V8 passera de 4 144 à
   ~768 MiB ; le pic observé (1,03 GiB de RSS sans contrainte) est sous la
   limite. C'est le seul conteneur de l'hôte qui pourrait aujourd'hui
   consommer la mémoire de BRouter ou de MariaDB.
2. **App et temps réel** : garder 768 MiB et 1,5 GiB, sans `NODE_OPTIONS`.
3. **Surveillance** : ajouter au relevé `scripts/vps/perf-snapshot.sh` le
   `memory.peak` et `oom_kill` de ces trois conteneurs, pour réviser les
   limites sur des pics réels plutôt que sur des instantanés.

À appliquer avec l'utilisateur (Coolify, puis redéploiement du service
concerné), en vérifiant ensuite le plancher Always Free (RAM utilisée
≥ 25 %, `server/vps/README.md`) : poser une limite ne réduit pas la mémoire
utilisée.

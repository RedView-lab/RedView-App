# Moteur neige v2 — banc de qualité

Généré le 2026-10-04T11:39:21.337Z par `npm run bench:snow` (script-test-bench/snow-quality).

**Portée.** La vérité terrain est synthétique : un modèle de référence écrit dans le banc, avec des formulations et des paramètres différents de ceux du moteur (manteau degré-jour sans terme radiatif, vent statistique type Winstral, rétention exponentielle 20·e^(−0,065·S), routage ∝ pente⁴, fonte par exposition sans ombres portées, bruit corrélé de 12 %). Le banc vérifie la descente d’échelle, l’assimilation, la conservation de la masse et le sens des processus ; il ne mesure pas la justesse réelle des congères fines (pas encore de cartes de hauteur mesurées).

## Tests physiques

| Test | Résultat | Détail |
|---|---|---|
| Terrain plat + AROME uniforme → champ uniforme | OK | moyenne 100.0 cm, min 100.0, max 100.0 |
| Descente d’échelle altitudinale (gradient 12 cm/100 m) | OK | bas 60 cm (attendu 61) à 1708 m, haut 129 cm (attendu 131) à 2293 m |
| Hauteur de rétention SnowSlide (m) à 30/40/50/60/75° | OK | 3.56 / 2.00 / 1.28 / 0.89 / 0.15 |
| SnowSlide : masse conservée, dépôt au pied, paroi délestée | OK | pied 740 cm, paroi 50° 90 cm (rétention 127 cm), sortie 0.0 % |
| Vent d’ouest : crête érodée, versant sous le vent chargé | OK | versant ouest 35 cm, crête 112 cm, versant est 224 cm (rose history) |
| Fonte différentielle : versant sud < versant nord | OK | exposé nord 153 cm, exposé sud 106 cm, fonte à plat 80 cm |
| Forêt dense, plein hiver : −40 % (Varhola 2010) | OK | moyenne 61.4 cm (attendu ≈ 60) |
| Assimilation : AROME −40 % corrigé, station fautive rejetée | OK | champ 137 cm (vrai 135), LOO RMSE 7.7 cm, k = 1.41, station fautive rejetée |
| Sondage dans la scène : le champ passe par la mesure | OK | au sondage 179 cm (mesuré 180), à 275 m 100 cm |
| Pas de neige → champ nul | OK | max 0 cm, 1 ms |
| Déterminisme (deux calculs identiques) | OK | écart max 0 |
| Position du soleil (Grenoble, solstice, midi solaire) | OK | azimut 178.8°, hauteur 68.2° (attendu 68.3°) |

## Scénarios (scène 2,4 km, maille 3,76 m)

| Scénario | Date | Vérité moy. | RMSE v1 → v2 (cm) | Biais v1 → v2 (cm) | r v1 → v2 | Masse v1 → v2 | Biais/altitude v1 → v2 (cm) | SSIM 30 m v1 → v2 | κ neige v1 → v2 | Temps v1 / v2 |
|---|---|---|---|---|---|---|---|---|---|---|
| hiver-nw | 2026-02-15 | 146.6 cm | 135.0 → **77.7** | -35.3 → **-10.9** | 0.08 → **0.59** | 0.76 → **0.93** | 47.4 → **12.9** | 0.13 → **0.64** | 0.00 → **0.00** | 3.6 s / 6.6 s |
| hiver-arome-biaise+stations | 2026-02-20 | 114.7 cm | 104.9 → **69.6** | -58.6 → **-5.5** | 0.28 → **0.61** | 0.49 → **0.95** | 61.8 → **9.2** | 0.20 → **0.68** | 0.01 → **0.03** | 3.5 s / 6.4 s |
| printemps-fonte | 2026-04-12 | 82.2 cm | 108.6 → **69.9** | -7.4 → **11.9** | 0.31 → **0.71** | 0.91 → **1.14** | 59.0 → **11.9** | 0.33 → **0.68** | 0.02 → **0.38** | 3.6 s / 6.4 s |
| debut-saison-vent | 2026-12-10 | 27.9 cm | 36.9 → **16.6** | -0.4 → **4.9** | 0.30 → **0.85** | 0.99 → **1.18** | 9.1 → **5.0** | 0.29 → **0.73** | 0.06 → **0.26** | 3.5 s / 3.6 s |

### Par échelle d’agrégation (corrélation r et NSE)

| Scénario | 30 m v1 → v2 | 100 m v1 → v2 | 400 m v1 → v2 |
|---|---|---|---|
| hiver-nw | r 0.05 → **0.70**, NSE -1.48 → **0.47** | r -0.04 → **0.80**, NSE -2.35 → **0.61** | r -0.30 → **0.84**, NSE -6.47 → **0.56** |
| hiver-arome-biaise+stations | r 0.27 → **0.68**, NSE -0.60 → **0.46** | r 0.22 → **0.78**, NSE -1.11 → **0.60** | r 0.04 → **0.89**, NSE -4.54 → **0.72** |
| printemps-fonte | r 0.30 → **0.82**, NSE -0.46 → **0.64** | r 0.19 → **0.89**, NSE -0.78 → **0.76** | r -0.16 → **0.92**, NSE -1.51 → **0.79** |
| debut-saison-vent | r 0.31 → **0.90**, NSE -0.49 → **0.77** | r 0.33 → **0.93**, NSE -0.45 → **0.81** | r 0.07 → **0.94**, NSE -2.22 → **0.67** |

### Mesures (validation croisée : chaque station prédite par les autres)

| Scénario | Stations | Erreur AROME brut (RMSE) | Erreur après assimilation (LOO) | Facteur précip. k | Décalage limite pluie-neige | BRA |
|---|---|---|---|---|---|---|
| hiver-nw | 0 | – | – | 1.00 | 0 m | non |
| hiver-arome-biaise+stations | 7 | 40.9 cm | **4.1 cm** | 1.40 | -260 m | oui |
| printemps-fonte | 5 | 14.0 cm | **1.1 cm** | 0.93 | 80 m | oui |
| debut-saison-vent | 3 | 4.2 cm | **5.6 cm** | 0.95 | 0 m | non |

### Ce que le moteur a fait

| Scénario | Gradient profil | Vent (source, % déplacé) | Avalanches (% déplacé) | Fonte à plat | Facteur radiatif (BRA) | σ modèle / σ Helbig |
|---|---|---|---|---|---|---|
| hiver-nw | 4.6 cm/100 m | history, 9.7 % | 12.0 % | 0.0 cm | 1.00 | 78.3 / 100.3 cm |
| hiver-arome-biaise+stations | 3.4 cm/100 m | history, 12.5 % | 10.9 % | 0.0 cm | 0.25 (calé BRA) | 64.6 / 92.4 cm |
| printemps-fonte | 7.1 cm/100 m | history, 14.3 % | 15.8 % | 16.9 cm | 1.24 (calé BRA) | 88.2 / 94.0 cm |
| debut-saison-vent | 1.3 cm/100 m | history, 34.6 % | 0.1 % | 0.0 cm | 1.00 | 26.0 / 49.0 cm |

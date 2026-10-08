# Licences des dépendances livrées

> Fichier généré par `npm run sbom` (`scripts/quality/sbom.mjs`) : ne pas l'éditer à la main.
> SBOM CycloneDX 1.5 à côté : [`sbom/server.cdx.json`](sbom/server.cdx.json) et [`sbom/browser.cdx.json`](sbom/browser.cdx.json).

Deux ensembles livrés :

- **serveur** : paquets installés dans les images Docker (`npm ci --omit=dev`) — 54 paquets (MIT 41 · Apache-2.0 9 · ISC 2 · BSD-3-Clause 1 · CC0-1.0 1) ;
- **navigateur** : paquets inclus dans le build Vite — 28 paquets (MIT 20 · CC0-1.0 2 · SEE LICENSE IN LICENSE.txt 2 · Apache-2.0 1 · BSD-3-Clause 1 · ISC 1 · MPL-2.0 1).

Le script échoue sur une licence copyleft forte (GPL, AGPL, EUPL, SSPL…), absente ou inconnue qui n'a pas été revue. Une exception revue s'ajoute dans `REVIEWED` du script, avec sa raison.

## Exceptions revues

- `@garmin/fitsdk` : Licence du protocole FIT de Garmin (non exclusive, gratuite) : lecture/écriture de fichiers FIT. Garder le fichier LICENSE.txt du paquet ; ne pas redistribuer le SDK seul.
- `mapbox-gl` : Conditions Mapbox (propriétaire, v2+) : usage permis avec un compte Mapbox actif, pour les produits Mapbox du compte. Le jeton VITE_MAPBOX_TOKEN est celui de ce compte.
- `mediabunny` : MPL-2.0 (copyleft faible, au fichier) : utilisé sans modification ; une modification de ses fichiers devrait être publiée sous MPL-2.0.

## Hors de cet inventaire

- **Moteurs Rust/WASM** (`vendor/redviewalgo`, `vendor/redviewlaz`, compilés dans `.wasm`) : crates sous MIT, Apache-2.0, « MIT OR Apache-2.0 », « Unlicense OR MIT » et Unicode-3.0 (`unicode-ident`), relevé le 2026-10-08 sur leurs `Cargo.lock` ; dont `laz` (Apache-2.0), `fitparser` (MIT), `quick-xml` (MIT), `wasm-bindgen` (MIT OR Apache-2.0).
- **Police** Rethink Sans (`@fontsource-variable/rethink-sans`, fichiers de police servis par l'app) : SIL OFL 1.1.
- **Code copié dans `public/`** (Service Worker, `laz-perf.wasm`) : couvert par les paquets ci-dessus ou écrit pour RedView.
- **Images Docker** : `node:22-alpine` (Node.js MIT, Alpine et ses paquets sous licences diverses), non scanné ici.

## Serveur

| Paquet | Version | Licence | Statut |
| --- | --- | --- | --- |
| `@emnapi/core` | 1.11.2 | MIT | permissive |
| `@emnapi/runtime` | 1.11.2 | MIT | permissive |
| `@emnapi/wasi-threads` | 1.2.2 | MIT | permissive |
| `@mattnucc/gribberish` | 0.30.2 | MIT | permissive |
| `@mattnucc/gribberish-darwin-arm64` (binaire de plateforme) | 0.30.2 | MIT | permissive |
| `@mattnucc/gribberish-darwin-x64` (binaire de plateforme) | 0.30.2 | MIT | permissive |
| `@mattnucc/gribberish-linux-x64-gnu` (binaire de plateforme) | 0.30.2 | MIT | permissive |
| `@mattnucc/gribberish-wasm32-wasi` (binaire de plateforme) | 0.30.2 | MIT | permissive |
| `@mattnucc/gribberish-win32-x64-msvc` (binaire de plateforme) | 0.30.2 | MIT | permissive |
| `@napi-rs/wasm-runtime` | 1.2.4 | MIT | permissive |
| `@opentelemetry/api` | 1.9.1 | Apache-2.0 | permissive |
| `@opentelemetry/api-logs` | 0.220.0 | Apache-2.0 | permissive |
| `@opentelemetry/core` | 2.12.0 | Apache-2.0 | permissive |
| `@opentelemetry/instrumentation` | 0.220.0 | Apache-2.0 | permissive |
| `@opentelemetry/resources` | 2.12.0 | Apache-2.0 | permissive |
| `@opentelemetry/sdk-trace` | 2.12.0 | Apache-2.0 | permissive |
| `@opentelemetry/sdk-trace-base` | 2.12.0 | Apache-2.0 | permissive |
| `@opentelemetry/semantic-conventions` | 1.43.0 | Apache-2.0 | permissive |
| `@pinojs/redact` | 0.4.0 | MIT | permissive |
| `@sentry/conventions` | 0.16.0 | MIT | permissive |
| `@sentry/core` | 10.76.1 | MIT | permissive |
| `@sentry/node` | 10.76.1 | MIT | permissive |
| `@sentry/node-core` | 10.76.1 | MIT | permissive |
| `@sentry/opentelemetry` | 10.76.1 | MIT | permissive |
| `@sentry/server-utils` | 10.76.1 | MIT | permissive |
| `@tybys/wasm-util` | 0.10.4 | MIT | permissive |
| `atomic-sleep` | 1.0.0 | MIT | permissive |
| `bignumber.js` | 9.3.1 | MIT | permissive |
| `cjs-module-lexer` | 2.3.0 | MIT | permissive |
| `debug` | 4.4.3 | MIT | permissive |
| `es-module-lexer` | 3.0.3 | MIT | permissive |
| `fractional-indexing` | 4.0.0 | CC0-1.0 | permissive |
| `get-caller-file` | 2.0.5 | ISC | permissive |
| `import-in-the-middle` | 3.5.2 | Apache-2.0 | permissive |
| `json-bigint` | 1.0.0 | MIT | permissive |
| `module-details-from-path` | 1.0.4 | MIT | permissive |
| `ms` | 2.1.3 | MIT | permissive |
| `node-appwrite` | 29.1.0 | BSD-3-Clause | permissive |
| `on-exit-leak-free` | 2.1.2 | MIT | permissive |
| `pino` | 10.4.0 | MIT | permissive |
| `pino-abstract-transport` | 3.0.0 | MIT | permissive |
| `pino-http` | 11.0.0 | MIT | permissive |
| `pino-std-serializers` | 7.1.0 | MIT | permissive |
| `process-warning` | 5.1.0 | MIT | permissive |
| `quick-format-unescaped` | 4.0.4 | MIT | permissive |
| `real-require` | 1.0.0 | MIT | permissive |
| `require-in-the-middle` | 8.0.1 | MIT | permissive |
| `safe-stable-stringify` | 2.5.0 | MIT | permissive |
| `sonic-boom` | 4.2.1 | MIT | permissive |
| `split2` | 4.2.0 | ISC | permissive |
| `stripe` | 22.1.0 | MIT | permissive |
| `thread-stream` | 4.2.0 | MIT | permissive |
| `undici` | 6.28.1 | MIT | permissive |
| `ws` | 8.21.0 | MIT | permissive |

## Navigateur

| Paquet | Version | Licence | Statut |
| --- | --- | --- | --- |
| `@garmin/fitsdk` | 21.218.0 | SEE LICENSE IN LICENSE.txt | revue |
| `@mapbox/mapbox-gl-draw` | 1.5.1 | ISC | permissive |
| `@photostructure/tz-lookup` | 11.7.0 | CC0-1.0 | permissive |
| `@sentry/browser` | 10.76.1 | MIT | permissive |
| `@sentry/browser-utils` | 10.76.1 | MIT | permissive |
| `@sentry/conventions` | 0.16.0 | MIT | permissive |
| `@sentry/core` | 10.76.1 | MIT | permissive |
| `@sentry/react` | 10.76.1 | MIT | permissive |
| `@stripe/react-stripe-js` | 3.10.0 | MIT | permissive |
| `@stripe/stripe-js` | 5.10.0 | MIT | permissive |
| `@tanstack/query-core` | 5.104.1 | MIT | permissive |
| `@tanstack/react-query` | 5.104.1 | MIT | permissive |
| `appwrite` | 26.2.0 | BSD-3-Clause | permissive |
| `bignumber.js` | 9.3.1 | MIT | permissive |
| `copc` | 0.0.8 | MIT | permissive |
| `cross-fetch` | 3.2.0 | MIT | permissive |
| `fractional-indexing` | 4.0.0 | CC0-1.0 | permissive |
| `json-bigint` | 1.0.0 | MIT | permissive |
| `laz-perf` | 0.0.7 | Apache-2.0 | permissive |
| `mapbox-gl` | 3.21.0 | SEE LICENSE IN LICENSE.txt | revue |
| `mediabunny` | 1.61.3 | MPL-2.0 | revue |
| `mgrs` | 1.0.0 | MIT | permissive |
| `proj4` | 2.22.0 | MIT | permissive |
| `react` | 19.3.0 | MIT | permissive |
| `react-dom` | 19.3.0 | MIT | permissive |
| `scheduler` | 0.28.0 | MIT | permissive |
| `sonner` | 2.0.8 | MIT | permissive |
| `wkt-parser` | 1.5.5 | MIT | permissive |

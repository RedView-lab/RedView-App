export * from './types';
export * from './coordConvert';
export * from './japanIndex';
// japanLazIndex (≈ 1,6 MB) / stacClient ne sont volontairement PAS ré-exportés :
// ce barrel est atteint statiquement depuis le Dashboard (coordConvert.ts) ;
// downloader.ts les charge par import dynamique.

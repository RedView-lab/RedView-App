export type JapanZoneNumber =
  | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10
  | 11 | 12 | 13 | 14 | 15 | 16 | 17 | 18 | 19;

/** 1km x 1km tile in Japan Plane Rectangular CS (JGD2011 Zone 1..19) */
export interface JapanTileCoord {
  eastKm: number;
  northKm: number;
  zone: JapanZoneNumber;
}

/** Japanese Base Map Standard Sheet (公共測量標準図郭) info */
export interface JapanMapSheetInfo {
  zone: JapanZoneNumber;
  zoneStr: string; // e.g. "08", "09"
  rowLetter: string; // e.g. "L", "M", "N", "K"
  colLetter: string; // e.g. "C", "D", "E", "F"
  sheet5k: string; // 2 digits e.g. "01", "23", "49"
  subSheet: string; // 2 digits e.g. "06", "30", "79"
  sheetCode: string; // e.g. "09LC0106", "08NF2330"
}

/** JIS X 0410 Regional Mesh (地域メッシュ) info */
export interface JapanTertiaryMeshInfo {
  mesh1st: string; // 4 digits (e.g. "5339")
  mesh2nd: string; // 2 digits (e.g. "46")
  mesh3rd: string; // 2 digits (e.g. "11")
  fullCode: string; // 8 digits (e.g. "53394611")
}

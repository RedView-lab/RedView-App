export interface NzTileCoord {
  eastKm: number;
  northKm: number;
}

export interface NzTileStacItem {
  id: string;
  coord: NzTileCoord;
  href: string;
  contentType?: string;
  collectionId?: string;
  datetime?: string;
}

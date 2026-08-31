export type PointFilterCategoryId =
  | 'ground'
  | 'vegetationHigh'
  | 'vegetationMedium'
  | 'vegetationLow'
  | 'buildings'
  | 'water'
  | 'bridges'
  | 'unclassified'
  | 'noise';

export interface PointFilterCategoryConfig {
  id: PointFilterCategoryId;
  label: string;
  classCodes: readonly number[];
  defaultVisible: boolean;
}

export type PointFilterCategoryVisibility = Record<PointFilterCategoryId, boolean>;

export interface ViewerPointFilterState {
  enabled: boolean;
  categories: PointFilterCategoryVisibility;
}

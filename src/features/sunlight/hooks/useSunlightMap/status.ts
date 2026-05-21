import { createOverlayStatus } from '@/features/map3d';

const STATUS_ID = 'sunlight-map' as const;
const STATUS_LABEL = "Carte d'ensoleillement";

export function sunlightMapLoadingStatus(progress: number, detail: string) {
  return createOverlayStatus({
    id: STATUS_ID,
    label: STATUS_LABEL,
    state: 'loading',
    progress,
    detail,
    reloadable: true,
  });
}

export function sunlightMapReadyStatus(detail = 'Overlay pret') {
  return createOverlayStatus({
    id: STATUS_ID,
    label: STATUS_LABEL,
    state: 'ready',
    progress: 100,
    detail,
    reloadable: true,
  });
}

export function sunlightMapErrorStatus(detail: string) {
  return createOverlayStatus({
    id: STATUS_ID,
    label: STATUS_LABEL,
    state: 'error',
    progress: 0,
    detail,
    reloadable: true,
  });
}

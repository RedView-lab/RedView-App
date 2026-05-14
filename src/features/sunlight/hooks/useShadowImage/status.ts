import { createOverlayStatus } from '@/features/map3d';

const STATUS_ID = 'shadow' as const;
const STATUS_LABEL = 'Ombres';

export function shadowLoadingStatus(progress: number, detail: string) {
  return createOverlayStatus({
    id: STATUS_ID,
    label: STATUS_LABEL,
    state: 'loading',
    progress,
    detail,
    reloadable: true,
  });
}

export function shadowReadyStatus(detail = 'Overlay pret') {
  return createOverlayStatus({
    id: STATUS_ID,
    label: STATUS_LABEL,
    state: 'ready',
    progress: 100,
    detail,
    reloadable: true,
  });
}

export function shadowErrorStatus(detail: string) {
  return createOverlayStatus({
    id: STATUS_ID,
    label: STATUS_LABEL,
    state: 'error',
    progress: 0,
    detail,
    reloadable: true,
  });
}

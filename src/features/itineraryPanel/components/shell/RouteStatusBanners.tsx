import type { ItineraryPanelProps } from '../../types';

type RouteStatusBannersProps = Pick<ItineraryPanelProps, 'routeError' | 'routeWarnings'>;

export function RouteStatusBanners({ routeError, routeWarnings }: RouteStatusBannersProps) {
  if (!routeError && (!routeWarnings || routeWarnings.length === 0)) {
    return null;
  }

  return (
    <>
      {routeError ? (
        <div className="rvi-route-banner rvi-route-banner--error" role="alert">
          {routeError}
        </div>
      ) : null}
      {routeWarnings && routeWarnings.length > 0 ? (
        <div className="rvi-route-banner rvi-route-banner--warn" role="status">
          {routeWarnings.map((warning, index) => (
            <div key={index}>{warning}</div>
          ))}
        </div>
      ) : null}
    </>
  );
}
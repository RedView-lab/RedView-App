import { AnalysisChart } from '../chart';
import type { AnalysisChartProps } from '../chart/AnalysisChart/types';
import { useFlyoverCursorXValue } from '../../flyover';

/**
 * Graphique d'analyse dont le curseur suit la tête du flyover pendant une
 * lecture. L'abonnement (≤ 30 Hz) est ici : seul le graphique se re-rend,
 * pas tout le panneau d'analyse.
 */
export function AnalysisChartWithFlyoverCursor(props: AnalysisChartProps) {
  const flyoverXValue = useFlyoverCursorXValue();
  return <AnalysisChart {...props} controlledHoverXValue={flyoverXValue ?? props.controlledHoverXValue ?? null} />;
}

import { IconBikeShop, IconRun, IconTrail } from '../../components/iconsFigma';
import type { ActivityType } from '../../lib/project/syncTracageParams';

export function ActivityIcon({ activity, size }: { activity: ActivityType; size: number }) {
  if (activity === 'trail') return <IconTrail size={size} />;
  if (activity === 'running') return <IconRun size={size} />;
  return <IconBikeShop size={size} />;
}

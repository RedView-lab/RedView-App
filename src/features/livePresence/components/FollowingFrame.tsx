import type { CSSProperties } from 'react';

import { UserAvatar } from '@/shared/components/UserAvatar/UserAvatar';
import { userAvatarColor } from '@/shared/components/UserAvatar/avatarColor';
import { useAppI18n } from '@/shared/i18n';

import { useLivePresenceOptional } from '../context/LivePresenceContext';
import '../styles/livePresence.css';

interface FollowingFrameProps {
  /** Bords de la carte couverts par l'interface : le bandeau se centre dans la zone visible. */
  insets: { top: number; right: number; bottom: number; left: number };
}

/** Écart entre le haut de la zone visible et le bandeau. */
const BANNER_GAP_PX = 12;

/**
 * Mode observation (Figma) : bord de la couleur de l'éditeur suivi autour de
 * la carte, et en haut de la zone visible un bandeau « Vous suivez … » avec
 * « Arrêter » (Échap ou un geste sur la carte arrêtent aussi). En
 * présentation : « Vous présentez votre vue ».
 */
export function FollowingFrame({ insets }: FollowingFrameProps) {
  const live = useLivePresenceOptional();
  const { t } = useAppI18n();
  if (!live) return null;
  const { following, presenting, followers } = live;
  if (!following && !presenting) return null;

  const userId = following ? following.userId : live.selfUserId ?? '';
  const name = following ? following.name : live.selfName || t('Vous');
  const color = following ? following.color : userAvatarColor(userId);
  let label: string;
  if (following) label = t('Vous suivez {{name}}', { name: following.name });
  else if (followers.length === 0) label = t('Vous présentez votre vue');
  else if (followers.length === 1) label = t('Vous présentez votre vue · 1 personne vous suit');
  else label = t('Vous présentez votre vue · {{count}} personnes vous suivent', { count: followers.length });

  const style = { '--rv-peer-color': color } as CSSProperties;
  return (
    <>
      <div className="rv-following-frame" style={style} aria-hidden="true" />
      <div
        className="rv-following-banner-anchor"
        style={{ top: insets.top + BANNER_GAP_PX, left: insets.left, right: insets.right }}
      >
        <div className="rv-glass rv-following-banner" style={style} role="status">
          <UserAvatar userId={userId} name={name} size={20} />
          <span className="rv-following-banner__label">{label}</span>
          <button
            type="button"
            className="rv-following-banner__stop"
            title={following ? t('Arrêter de suivre (Échap)') : t('Arrêter de présenter')}
            onClick={() => (following ? live.stopFollowing() : live.setPresenting(false))}
          >
            {t('Arrêter')}
          </button>
        </div>
      </div>
    </>
  );
}

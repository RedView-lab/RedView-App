import type { BrfFootValues } from './types';

/**
 * Section ---context:node du profil BRF piéton : accès `foot` sur les nœuds
 * (barrières, portails) et coût des feux / stops pour la course sur route.
 * En trail, un feu ne coûte rien (quelques traversées de village).
 */
export function buildBrfFootNodeContext(style: BrfFootValues['style']): string {
  const signalCost = style === 'running'
    ? `if or highway=traffic_signals and highway=crossing crossing=traffic_signals then multiply user_signal_penalty 0.5
  else if highway=stop then multiply user_signal_penalty 0.15
  else 0`
    : '0';

  return `
---context:node

assign defaultaccess =
       if ( access= ) then true
       else if ( access=private|no ) then false
       else true

assign footaccess =
       if nodeaccessgranted=yes then true
       else if foot=yes|designated|permissive then true
       else if foot=no|private then false
       else if bicycle=dismount then true
       else defaultaccess

assign initialcost =
  if not footaccess then 1000000
  else ${signalCost}
`;
}

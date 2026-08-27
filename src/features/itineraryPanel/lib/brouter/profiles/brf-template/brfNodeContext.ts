/**
 * Section ---context:node du profil BRF BRouter.
 */
export const BRF_NODE_CONTEXT = `
---context:node

assign defaultaccess =
       if ( access= ) then true
       else if ( access=private|no ) then false
       else true

assign bikeaccess =
       if nodeaccessgranted=yes then true
       else if bicycle= then
       (
         if vehicle= then defaultaccess
         else not vehicle=private|no
       )
       else not bicycle=private|no|dismount

assign footaccess =
       if bicycle=dismount then true
       else if foot= then defaultaccess
       else not foot=private|no

assign initialcost =
  if or highway=traffic_signals and highway=crossing crossing=traffic_signals then user_signal_penalty
  else if highway=stop then multiply user_signal_penalty 0.35
  else if highway=give_way then multiply user_signal_penalty 0.2
       else
       if bikeaccess then 0
       else ( if footaccess then 100 else 1000000 )
`;

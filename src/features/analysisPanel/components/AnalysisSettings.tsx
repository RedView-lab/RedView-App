import React from 'react';
import { ChevronDown } from './Icons';
import { imgLine113, imgLine112, imgLine93, imgIcon4 } from './assets';

export function AnalysisSettings() {
  return (
        <div className="content-stretch flex gap-[12px] items-center relative shrink-0 w-full" data-node-id="1894:38976" data-name="SETTINGS">
          <div className="flex flex-col font-['Rethink_Sans:SemiBold',sans-serif] font-semibold justify-center leading-[0] relative shrink-0 text-[13px] text-white whitespace-nowrap" data-node-id="1894:38977">
            <p className="leading-[normal]">Analyse</p>
          </div>
          <div className="bg-[rgba(255,255,255,0.04)] content-stretch flex gap-[2px] h-[30px] items-center justify-center p-[2px] relative rounded-[6px] shrink-0" data-node-id="1894:38978">
            <div className="bg-[rgba(0,0,0,0.64)] content-stretch flex h-[26px] items-center justify-center px-[8px] py-[4px] relative rounded-[6px] shrink-0" data-node-id="1894:38979">
              <div className="flex flex-col font-['Rethink_Sans:SemiBold',sans-serif] font-semibold justify-center leading-[0] overflow-hidden relative shrink-0 text-[13px] text-ellipsis text-white whitespace-nowrap" data-node-id="1894:38980">
                <p className="leading-[normal] overflow-hidden text-ellipsis">Distance</p>
              </div>
            </div>
            <div className="bg-[rgba(0,0,0,0)] content-stretch flex h-[26px] items-center justify-center px-[8px] py-[4px] relative rounded-[6px] shrink-0" data-node-id="1894:38981">
              <div className="flex flex-col font-['Rethink_Sans:SemiBold',sans-serif] font-semibold justify-center leading-[0] overflow-hidden relative shrink-0 text-[13px] text-ellipsis text-white whitespace-nowrap" data-node-id="1894:38982">
                <p className="leading-[normal] overflow-hidden text-ellipsis">Temps</p>
              </div>
            </div>
          </div>
          <div className="content-stretch flex gap-[12px] h-[24px] items-center py-[3px] relative shrink-0" data-node-id="1894:38983">
            <div className="flex flex-col font-['Rethink_Sans:Bold',sans-serif] font-bold justify-center leading-[0] opacity-50 relative shrink-0 text-[12px] text-right text-white whitespace-nowrap" data-node-id="1894:38984">
              <p className="leading-[normal]">Détail</p>
            </div>
            <div className="content-stretch flex gap-[4px] items-center max-w-[140px] relative shrink-0" data-node-id="1894:38985">
              <div className="flex flex-col font-['Rethink_Sans:SemiBold',sans-serif] font-semibold justify-center leading-[0] relative shrink-0 text-[11px] text-white whitespace-nowrap" data-node-id="1894:38986">
                <p className="leading-[normal]">-</p>
              </div>
              <div className="h-[24px] relative shrink-0 w-[48px]" data-node-id="1894:38987" data-name="Slider">
                <div className="absolute bg-[rgba(255,255,255,0.08)] h-[8px] left-0 right-0 rounded-[var(--radius-full,9999px)] top-[8px]" data-node-id="1894:38988" data-name="Background" />
                <div className="absolute h-[8px] left-0 right-[49.49%] top-[8px]" data-node-id="1894:38989" data-name="Progress">
                  <div className="absolute bg-[#890000] inset-0 rounded-[var(--radius-full,9999px)]" data-node-id="1894:38990" data-name="Progress line" />
                  <div className="-translate-y-1/2 absolute bg-white border-2 border-[#700000] border-solid right-[-7.76px] rounded-[var(--radius-full,9999px)] shadow-[0px_4px_6px_-1px_var(--colors\/effects\/shadows\/shadow-md_01,rgba(10,13,18,0.1)),0px_2px_4px_-2px_var(--colors\/effects\/shadows\/shadow-md_02,rgba(10,13,18,0.06))] size-[16px] top-1/2" data-node-id="1894:38992" data-name="Handle" />
                </div>
              </div>
              <div className="flex flex-col font-['Rethink_Sans:SemiBold',sans-serif] font-semibold justify-center leading-[0] relative shrink-0 text-[11px] text-white whitespace-nowrap" data-node-id="1894:38993">
                <p className="leading-[normal]">+</p>
              </div>
            </div>
          </div>
          <div className="content-stretch flex flex-col gap-[4px] items-center justify-center relative shrink-0" data-node-id="1894:38994">
            <div className="flex flex-col font-['Rethink_Sans:Bold',sans-serif] font-bold justify-center leading-[0] opacity-50 relative shrink-0 text-[12px] text-right text-white w-[32px]" data-node-id="1894:38995">
              <p className="leading-[normal]">Axe 1</p>
            </div>
            <div className="h-0 relative shrink-0 w-[12px]" data-node-id="1894:38996">
              <div className="absolute inset-[-3px_-25%_-3px_-8.33%]">
                <img alt="" className="block max-w-none size-full" src={imgLine113} />
              </div>
            </div>
          </div>
          <div className="border-[#444] border-[1.5px] border-solid content-stretch flex flex-[1_0_0] items-center justify-between max-w-[116px] min-w-[80px] pl-[12px] pr-[8px] py-[6px] relative rounded-[6px]" data-node-id="1894:38997">
            <div className="flex flex-[1_0_0] flex-col font-['Rethink_Sans:Medium',sans-serif] font-medium justify-center leading-[0] min-w-px overflow-hidden relative text-[12px] text-ellipsis text-white whitespace-nowrap" data-node-id="1894:38998">
              <p className="leading-[normal] overflow-hidden text-ellipsis">Dénivelé</p>
            </div>
            <ChevronDown className="overflow-clip relative shrink-0 size-[20px]" />
          </div>
          <div className="content-stretch flex flex-col gap-[4px] items-center justify-center relative shrink-0" data-node-id="1894:39000">
            <div className="flex flex-col font-['Rethink_Sans:Bold',sans-serif] font-bold justify-center leading-[0] opacity-50 relative shrink-0 text-[12px] text-right text-white w-[32px]" data-node-id="1894:39001">
              <p className="leading-[normal]">Axe 2</p>
            </div>
            <div className="h-0 relative shrink-0 w-[12px]" data-node-id="1894:39002">
              <div className="absolute inset-[-3px_-25%_-3px_-8.33%]">
                <img alt="" className="block max-w-none size-full" src={imgLine112} />
              </div>
            </div>
          </div>
          <div className="border-[#444] border-[1.5px] border-solid content-stretch flex flex-[1_0_0] items-center justify-between max-w-[116px] min-w-[80px] pl-[12px] pr-[8px] py-[6px] relative rounded-[6px]" data-node-id="1894:39003">
            <div className="flex flex-[1_0_0] flex-col font-['Rethink_Sans:Medium',sans-serif] font-medium justify-center leading-[0] min-w-px overflow-hidden relative text-[12px] text-ellipsis text-white whitespace-nowrap" data-node-id="1894:39004">
              <p className="leading-[normal] overflow-hidden text-ellipsis">-</p>
            </div>
            <ChevronDown className="overflow-clip relative shrink-0 size-[20px]" />
          </div>
          <div className="flex flex-row items-center self-stretch">
            <div className="flex h-0 items-center justify-center relative self-center shrink-0 w-0" style={{ containerType: "size", "--transform-inner-width": "0", "--transform-inner-height": "0" } as React.CSSProperties}>
              <div className="-rotate-90 flex-none w-[100cqh]">
                <div className="h-0 relative w-full" data-node-id="1894:39006">
                  <div className="absolute inset-[-1px_0_0_0]">
                    <img alt="" className="block max-w-none size-full" src={imgLine93} />
                  </div>
                </div>
              </div>
            </div>
          </div>
          <div className="content-stretch flex gap-[4px] items-center relative shrink-0" data-node-id="1894:39007">
            <div className="bg-[rgba(255,255,255,0.08)] content-stretch flex gap-[4px] h-[32px] items-center px-[8px] py-[6px] relative rounded-[6px] shrink-0" data-node-id="1894:39008" data-name="Component 17">
              <div className="content-stretch flex items-center justify-center relative shrink-0" data-node-id="I1894:39008;977:25118" data-name="Checkbox">
                <div className="bg-[rgba(0,0,0,0.64)] overflow-clip relative rounded-[var(--spacing-xs,4px)] shrink-0 size-[16px]" data-node-id="I1894:39008;977:25118;1097:64015" data-name="_Checkbox base">
                  <div className="absolute inset-[12.5%] overflow-clip" data-node-id="I1894:39008;977:25118;1097:64015;1097:63897" data-name="check">
                    <div className="absolute bottom-[29.17%] left-[16.67%] right-[16.67%] top-1/4" data-node-id="I1894:39008;977:25118;1097:64015;1097:63897;3463:404965" data-name="Icon">
                      <div className="absolute inset-[-15.15%_-10.42%]">
                        <img alt="" className="block max-w-none size-full" src={imgIcon4} />
                      </div>
                    </div>
                  </div>
                </div>
              </div>
              <div className="flex flex-col font-['Rethink_Sans:Medium',sans-serif] font-medium justify-center leading-[0] overflow-hidden relative shrink-0 text-[12px] text-[rgba(255,255,255,0.64)] text-ellipsis whitespace-nowrap" data-node-id="I1894:39008;977:25123">
                <p className="leading-[normal] overflow-hidden text-ellipsis">Waypoint</p>
              </div>
            </div>
            <div className="bg-[rgba(255,255,255,0.08)] content-stretch flex gap-[4px] h-[32px] items-center px-[8px] py-[6px] relative rounded-[6px] shrink-0" data-node-id="1894:39009" data-name="Component 18">
              <div className="content-stretch flex items-center justify-center relative shrink-0" data-node-id="I1894:39009;977:25102" data-name="Checkbox">
                <div className="bg-[rgba(0,0,0,0.64)] overflow-clip relative rounded-[var(--spacing-xs,4px)] shrink-0 size-[16px]" data-node-id="I1894:39009;977:25102;1097:64015" data-name="_Checkbox base">
                  <div className="absolute inset-[12.5%] overflow-clip" data-node-id="I1894:39009;977:25102;1097:64015;1097:63897" data-name="check">
                    <div className="absolute bottom-[29.17%] left-[16.67%] right-[16.67%] top-1/4" data-node-id="I1894:39009;977:25102;1097:64015;1097:63897;3463:404965" data-name="Icon">
                      <div className="absolute inset-[-15.15%_-10.42%]">
                        <img alt="" className="block max-w-none size-full" src={imgIcon4} />
                      </div>
                    </div>
                  </div>
                </div>
              </div>
              <div className="flex flex-col font-['Rethink_Sans:Medium',sans-serif] font-medium justify-center leading-[0] overflow-hidden relative shrink-0 text-[12px] text-[rgba(255,255,255,0.64)] text-ellipsis whitespace-nowrap" data-node-id="I1894:39009;977:25108">
                <p className="leading-[normal] overflow-hidden text-ellipsis">POI</p>
              </div>
            </div>
            <div className="bg-[rgba(255,255,255,0.08)] content-stretch flex gap-[4px] h-[32px] items-center px-[8px] py-[6px] relative rounded-[6px] shrink-0" data-node-id="1894:39010" data-name="Component 16">
              <div className="content-stretch flex items-center justify-center relative shrink-0" data-node-id="I1894:39010;977:25125" data-name="Checkbox">
                <div className="bg-[rgba(0,0,0,0.64)] overflow-clip relative rounded-[var(--spacing-xs,4px)] shrink-0 size-[16px]" data-node-id="I1894:39010;977:25125;1097:64015" data-name="_Checkbox base">
                  <div className="absolute inset-[12.5%] overflow-clip" data-node-id="I1894:39010;977:25125;1097:64015;1097:63897" data-name="check">
                    <div className="absolute bottom-[29.17%] left-[16.67%] right-[16.67%] top-1/4" data-node-id="I1894:39010;977:25125;1097:64015;1097:63897;3463:404965" data-name="Icon">
                      <div className="absolute inset-[-15.15%_-10.42%]">
                        <img alt="" className="block max-w-none size-full" src={imgIcon4} />
                      </div>
                    </div>
                  </div>
                </div>
              </div>
              <div className="flex flex-col font-['Rethink_Sans:Medium',sans-serif] font-medium justify-center leading-[0] overflow-hidden relative shrink-0 text-[12px] text-[rgba(255,255,255,0.64)] text-ellipsis whitespace-nowrap" data-node-id="I1894:39010;977:25130">
                <p className="leading-[normal] overflow-hidden text-ellipsis">Pause</p>
              </div>
            </div>
            <div className="bg-[rgba(255,255,255,0.08)] content-stretch flex gap-[4px] h-[32px] items-center px-[8px] py-[6px] relative rounded-[6px] shrink-0" data-node-id="1894:39011" data-name="Component 21">
              <div className="content-stretch flex items-center justify-center relative shrink-0" data-node-id="I1894:39011;977:25125" data-name="Checkbox">
                <div className="bg-[rgba(0,0,0,0.64)] overflow-clip relative rounded-[var(--spacing-xs,4px)] shrink-0 size-[16px]" data-node-id="I1894:39011;977:25125;1097:64015" data-name="_Checkbox base">
                  <div className="absolute inset-[12.5%] overflow-clip" data-node-id="I1894:39011;977:25125;1097:64015;1097:63897" data-name="check">
                    <div className="absolute bottom-[29.17%] left-[16.67%] right-[16.67%] top-1/4" data-node-id="I1894:39011;977:25125;1097:64015;1097:63897;3463:404965" data-name="Icon">
                      <div className="absolute inset-[-15.15%_-10.42%]">
                        <img alt="" className="block max-w-none size-full" src={imgIcon4} />
                      </div>
                    </div>
                  </div>
                </div>
              </div>
              <div className="flex flex-col font-['Rethink_Sans:Medium',sans-serif] font-medium justify-center leading-[0] overflow-hidden relative shrink-0 text-[12px] text-[rgba(255,255,255,0.64)] text-ellipsis whitespace-nowrap" data-node-id="I1894:39011;977:25130">
                <p className="leading-[normal] overflow-hidden text-ellipsis">Alertes</p>
              </div>
            </div>
            <div className="bg-[rgba(255,255,255,0.08)] content-stretch flex gap-[4px] h-[32px] items-center px-[8px] py-[6px] relative rounded-[6px] shrink-0" data-node-id="1894:39012" data-name="Component 19">
              <div className="content-stretch flex items-center justify-center relative shrink-0" data-node-id="I1894:39012;977:25125" data-name="Checkbox">
                <div className="bg-[rgba(0,0,0,0.64)] overflow-clip relative rounded-[var(--spacing-xs,4px)] shrink-0 size-[16px]" data-node-id="I1894:39012;977:25125;1097:64015" data-name="_Checkbox base">
                  <div className="absolute inset-[12.5%] overflow-clip" data-node-id="I1894:39012;977:25125;1097:64015;1097:63897" data-name="check">
                    <div className="absolute bottom-[29.17%] left-[16.67%] right-[16.67%] top-1/4" data-node-id="I1894:39012;977:25125;1097:64015;1097:63897;3463:404965" data-name="Icon">
                      <div className="absolute inset-[-15.15%_-10.42%]">
                        <img alt="" className="block max-w-none size-full" src={imgIcon4} />
                      </div>
                    </div>
                  </div>
                </div>
              </div>
              <div className="flex flex-col font-['Rethink_Sans:Medium',sans-serif] font-medium justify-center leading-[0] overflow-hidden relative shrink-0 text-[12px] text-[rgba(255,255,255,0.64)] text-ellipsis whitespace-nowrap" data-node-id="I1894:39012;977:25130">
                <p className="leading-[normal] overflow-hidden text-ellipsis">Pente</p>
              </div>
            </div>
            <div className="bg-[rgba(255,255,255,0.08)] content-stretch flex gap-[4px] h-[32px] items-center px-[8px] py-[6px] relative rounded-[6px] shrink-0" data-node-id="1894:39013" data-name="Component 20">
              <div className="content-stretch flex items-center justify-center relative shrink-0" data-node-id="I1894:39013;977:25125" data-name="Checkbox">
                <div className="bg-[rgba(0,0,0,0.64)] overflow-clip relative rounded-[var(--spacing-xs,4px)] shrink-0 size-[16px]" data-node-id="I1894:39013;977:25125;1097:64015" data-name="_Checkbox base">
                  <div className="absolute inset-[12.5%] overflow-clip" data-node-id="I1894:39013;977:25125;1097:64015;1097:63897" data-name="check">
                    <div className="absolute bottom-[29.17%] left-[16.67%] right-[16.67%] top-1/4" data-node-id="I1894:39013;977:25125;1097:64015;1097:63897;3463:404965" data-name="Icon">
                      <div className="absolute inset-[-15.15%_-10.42%]">
                        <img alt="" className="block max-w-none size-full" src={imgIcon4} />
                      </div>
                    </div>
                  </div>
                </div>
              </div>
              <div className="flex flex-col font-['Rethink_Sans:Medium',sans-serif] font-medium justify-center leading-[0] overflow-hidden relative shrink-0 text-[12px] text-[rgba(255,255,255,0.64)] text-ellipsis whitespace-nowrap" data-node-id="I1894:39013;977:25130">
                <p className="leading-[normal] overflow-hidden text-ellipsis">Jour/nuit</p>
              </div>
            </div>
          </div>
        </div>
  );
}

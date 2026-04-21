import { imgIcon2, imgIcon3 } from './assets';
import { Settings } from './Icons';

export type Frame1Props = {
  className?: string;
  property1?: "Default" | "Variant2";
};

export function Frame1({ className, property1 = "Default" }: Frame1Props) {
  const isDefault = property1 === "Default";
  const isVariant2 = property1 === "Variant2";
  return (
    <div className={className || `content-stretch flex gap-[8px] items-center px-[2px] relative rounded-[6px] ${isVariant2 ? "w-[1126px]" : "bg-[rgba(0,0,0,0.6)] w-[1214px]"}`} id={isVariant2 ? "node-1168_18007" : "node-217_5482"}>
      <div className={`flex relative shrink-0 w-[120px] ${isVariant2 ? 'flex-col font-["Rethink_Sans:SemiBold",sans-serif] font-semibold justify-center leading-[0] overflow-hidden text-[13px] text-ellipsis text-white whitespace-nowrap' : "content-stretch gap-[8px] items-center px-[8px] py-[7px] rounded-[6px]"}`} id={isVariant2 ? "node-1168_18029" : "node-217_5479"}>
        {isDefault && (
          <>
            <div className="content-stretch flex gap-[4px] items-center relative shrink-0" data-node-id="630:17475">
              <div className="overflow-clip relative shrink-0 size-[16px]" data-node-id="588:23676" data-name="eye">
                <div className="absolute inset-[20.83%_8.98%]" data-node-id="I588:23676;5044:27874" data-name="Icon">
                  <div className="absolute inset-[-7.16%_-5.09%]">
                    <img alt="" className="block max-w-none size-full" src={imgIcon2} />
                  </div>
                </div>
              </div>
              <div className="bg-[#c50000] rounded-[2px] shrink-0 size-[12px]" data-node-id="376:6343" />
            </div>
            <div className="flex flex-[1_0_0] flex-col font-['Rethink_Sans:SemiBold',sans-serif] font-semibold justify-center leading-[0] min-w-px overflow-hidden relative text-[14px] text-ellipsis text-white whitespace-nowrap" data-node-id="217:5480">
              <p className="leading-[normal] overflow-hidden text-ellipsis">Itinéraire 1</p>
            </div>
          </>
        )}
        {isVariant2 && <p className="leading-[normal] overflow-hidden text-ellipsis">Synthèse</p>}
      </div>
      <div className={`content-stretch flex flex-[1_0_0] font-["Rethink_Sans:Medium",sans-serif] font-medium gap-[2px] items-center leading-[0] min-w-px overflow-clip relative text-right whitespace-nowrap ${isVariant2 ? "text-[13px] text-[rgba(255,255,255,0.64)]" : "text-[14px] text-white"}`} id={isVariant2 ? "node-1168_18013" : "node-217_5478"}>
        <div className="flex flex-[1_0_0] flex-col justify-center max-w-[80px] min-w-[64px] overflow-hidden relative text-ellipsis" id={isVariant2 ? "node-1168_18014" : "node-192_4103"}>
          <p className="leading-[normal] overflow-hidden text-ellipsis">{isVariant2 ? "Distance" : "12.78"}</p>
        </div>
        <div className="flex flex-[1_0_0] flex-col justify-center max-w-[88px] min-w-[64px] overflow-hidden relative text-ellipsis" id={isVariant2 ? "node-1168_18015" : "node-192_4104"}>
          <p className="leading-[normal] overflow-hidden text-ellipsis">{isVariant2 ? "Durée" : "00:00:23"}</p>
        </div>
        <div className="flex flex-[1_0_0] flex-col justify-center max-w-[88px] min-w-[64px] overflow-hidden relative text-ellipsis" id={isVariant2 ? "node-1168_18016" : "node-192_4105"}>
          <p className="leading-[normal] overflow-hidden text-ellipsis">{isVariant2 ? "Dénivelé /" : "+346"}</p>
        </div>
        <div className="flex flex-[1_0_0] flex-col justify-center max-w-[88px] min-w-[64px] overflow-hidden relative text-ellipsis" id={isVariant2 ? "node-1168_18017" : "node-192_4106"}>
          <p className="leading-[normal] overflow-hidden text-ellipsis">{isVariant2 ? "Dénivelé -" : "-33"}</p>
        </div>
        <div className="flex flex-[1_0_0] flex-col justify-center max-w-[88px] min-w-[64px] overflow-hidden relative text-ellipsis" id={isVariant2 ? "node-1168_18018" : "node-556_15828"}>
          <p className="leading-[normal] overflow-hidden text-ellipsis">{isVariant2 ? "Pente moyenne" : "7%"}</p>
        </div>
        <div className="flex flex-[1_0_0] flex-col justify-center max-w-[88px] min-w-[64px] overflow-hidden relative text-ellipsis" id={isVariant2 ? "node-1168_18019" : "node-740_14830"}>
          <p className="leading-[normal] overflow-hidden text-ellipsis">{isVariant2 ? "Tarmac" : "7%"}</p>
        </div>
        <div className="flex flex-[1_0_0] flex-col justify-center max-w-[88px] min-w-[64px] overflow-hidden relative text-ellipsis" id={isVariant2 ? "node-1168_18021" : "node-740_14883"}>
          <p className="leading-[normal] overflow-hidden text-ellipsis">{isVariant2 ? "Off-road" : "7%"}</p>
        </div>
        <div className="flex flex-[1_0_0] flex-col justify-center max-w-[88px] min-w-[64px] overflow-hidden relative text-ellipsis" id={isVariant2 ? "node-1168_18022" : "node-740_14936"}>
          <p className="leading-[normal] overflow-hidden text-ellipsis">7%</p>
        </div>
        <div className="flex flex-[1_0_0] flex-col justify-center max-w-[88px] min-w-[64px] overflow-hidden relative text-ellipsis" id={isVariant2 ? "node-1168_18023" : "node-740_14989"}>
          <p className="leading-[normal] overflow-hidden text-ellipsis">7%</p>
        </div>
        <div className="flex flex-[1_0_0] flex-col justify-center max-w-[88px] min-w-[64px] overflow-hidden relative text-ellipsis" id={isVariant2 ? "node-1894_41371" : "node-740_15042"}>
          <p className="leading-[normal] overflow-hidden text-ellipsis">7%</p>
        </div>
      </div>
      {isDefault && (
        <div className="content-stretch flex items-center justify-center overflow-clip p-[var(--spacing-md,8px)] relative rounded-[var(--radius-sm,6px)] shrink-0" data-node-id="740:14670" data-name="Buttons/Button utility">
          <div className="overflow-clip relative shrink-0 size-[16px]" data-node-id="I740:14670;7932:552036" data-name="Size=48">
            <div className="absolute inset-[16.67%_45.83%]" data-node-id="I740:14670;7932:552036;7758:11960" data-name="Icon">
              <div className="absolute inset-[-7.03%_-56.25%]">
                <img alt="" className="block max-w-none size-full" src={imgIcon3} />
              </div>
            </div>
          </div>
        </div>
      )}
      {isVariant2 && (
        <div className="bg-[rgba(255,255,255,0.12)] content-stretch flex h-[32px] items-center px-[12px] relative rounded-[6px] shrink-0" data-node-id="1168:18053">
          <Settings className="overflow-clip relative shrink-0 size-[16px]" />
        </div>
      )}
    </div>
  );
}

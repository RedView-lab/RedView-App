import React from 'react';
import { SvgV2Icon } from '@/components/SvgV2Icon';

export function AnalysisSlider() {
  return (
        <div className="content-stretch flex flex-col gap-[2px] items-start relative shrink-0 w-full" data-node-id="1894:39132" data-name="SLIDER">
          <div className="bg-[rgba(0,0,0,0.24)] h-[16px] shrink-0 w-full" data-node-id="1894:39133" />
          <div className="absolute bg-[rgba(255,255,255,0.32)] border-l-4 border-r-4 border-solid border-white h-[16px] left-[186px] top-0 w-[778px]" data-node-id="1894:39134" />
          <div className="-translate-x-1/2 -translate-y-1/2 absolute flex items-center justify-center left-1/2 size-[16px] top-1/2" style={{ "--transform-inner-width": "0", "--transform-inner-height": "0" } as React.CSSProperties}>
            <div className="-rotate-90 flex-none">
              <SvgV2Icon name="dots-vertical.svg" size={16} />
            </div>
          </div>
        </div>
  );
}

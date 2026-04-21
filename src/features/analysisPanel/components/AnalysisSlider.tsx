import React from 'react';
import { imgIcon8 } from './assets';

export function AnalysisSlider() {
  return (
        <div className="content-stretch flex flex-col gap-[2px] items-start relative shrink-0 w-full" data-node-id="1894:39132" data-name="SLIDER">
          <div className="bg-[rgba(0,0,0,0.24)] h-[16px] shrink-0 w-full" data-node-id="1894:39133" />
          <div className="absolute bg-[rgba(255,255,255,0.32)] border-l-4 border-r-4 border-solid border-white h-[16px] left-[186px] top-0 w-[778px]" data-node-id="1894:39134" />
          <div className="-translate-x-1/2 -translate-y-1/2 absolute flex items-center justify-center left-1/2 size-[16px] top-1/2" style={{ "--transform-inner-width": "0", "--transform-inner-height": "0" } as React.CSSProperties}>
            <div className="-rotate-90 flex-none">
              <div className="overflow-clip relative size-[16px]" data-node-id="1894:39135" data-name="dots-vertical">
                <div className="absolute inset-[16.67%_45.83%]" data-node-id="I1894:39135;207:5232" data-name="Icon">
                  <div className="absolute inset-[-7.03%_-56.25%]">
                    <img alt="" className="block max-w-none size-full" src={imgIcon8} />
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
  );
}

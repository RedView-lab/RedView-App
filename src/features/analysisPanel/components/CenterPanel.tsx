import type { CSSProperties } from 'react';
import { Synthesis } from './Synthesis';
import { AnalysisSettings } from './AnalysisSettings';
import { AnalysisResults } from './AnalysisResults';
import { AnalysisSlider } from './AnalysisSlider';
import { imgLine33 } from './assets';

export type CenterProps = {
  className?: string;
  style?: CSSProperties;
};

export function Center({ className, style }: CenterProps) {
  return (
    <div className={className || "backdrop-blur-[60px] bg-[rgba(15,15,15,0.74)] content-stretch flex flex-col gap-[12px] h-[456px] items-start min-h-[407px] p-[12px] relative rounded-[8px] w-[1308px]"} style={style} data-node-id="1894:39591">
      <Synthesis />
      <div className="h-0 relative shrink-0 w-full" data-node-id="1894:38937">
        <div className="absolute inset-[-1px_0_0_0]">
          <img alt="" className="block max-w-none size-full" src={imgLine33} />
        </div>
      </div>
      <div className="content-stretch flex flex-[1_0_0] flex-col gap-[12px] items-start min-h-px overflow-clip relative w-full" data-node-id="1894:38975" data-name="ANALYSIS">
        <AnalysisSettings />
        <AnalysisResults />
        <AnalysisSlider />
      </div>
    </div>
  );
}

export default Center;

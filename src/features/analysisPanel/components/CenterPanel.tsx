import type { CSSProperties } from 'react';
import { Synthesis } from './Synthesis';
import { AnalysisSettings } from './AnalysisSettings';
import {
  AnalysisResults,
  type AnalysisChartSeries,
  type AnalysisCursor,
} from './AnalysisResults';
import { AnalysisSlider } from './AnalysisSlider';
import { imgLine33 } from './assets';

const repeatedTemperatureValues = Array.from({ length: 10 }, () => '17°');

const demoSeries: AnalysisChartSeries[] = [
  {
    id: 'Température',
    color: '#ef1a12',
    strokeWidth: 0.58,
    cellValues: repeatedTemperatureValues,
    points: [
      { x: 0, y: 780 },
      { x: 5, y: 720 },
      { x: 8, y: 1320 },
      { x: 14, y: 0 },
      { x: 22, y: 640 },
      { x: 28, y: 1680 },
      { x: 36, y: 1100 },
      { x: 45, y: 980 },
      { x: 49, y: 380 },
      { x: 53, y: 1900 },
      { x: 58, y: 220 },
      { x: 63, y: 1180 },
      { x: 67, y: 0 },
      { x: 72, y: 1360 },
      { x: 79, y: 1240 },
      { x: 83, y: 160 },
      { x: 92, y: 0 },
      { x: 100, y: 420 },
    ],
  },
  {
    id: 'Température ressentie',
    color: '#ff9d60',
    strokeWidth: 0.52,
    opacity: 0.96,
    cellValues: repeatedTemperatureValues,
    points: [
      { x: 0, y: 2040 },
      { x: 4, y: 2120 },
      { x: 7, y: 1460 },
      { x: 12, y: 3180 },
      { x: 18, y: 3180 },
      { x: 23, y: 2040 },
      { x: 28, y: 1040 },
      { x: 33, y: 1860 },
      { x: 44, y: 1760 },
      { x: 49, y: 240 },
      { x: 52, y: 1960 },
      { x: 57, y: 1580 },
      { x: 66, y: 1320 },
      { x: 70, y: 1240 },
      { x: 73, y: 0 },
      { x: 79, y: 0 },
      { x: 84, y: 2740 },
      { x: 92, y: 3280 },
      { x: 100, y: 2520 },
    ],
  },
  {
    id: 'Température humide',
    color: '#ffd35a',
    strokeWidth: 0.46,
    opacity: 0.94,
    cellValues: repeatedTemperatureValues,
    points: [
      { x: 0, y: 2120 },
      { x: 4, y: 2200 },
      { x: 7, y: 1520 },
      { x: 12, y: 3320 },
      { x: 18, y: 3260 },
      { x: 23, y: 2140 },
      { x: 28, y: 1100 },
      { x: 33, y: 1760 },
      { x: 44, y: 1680 },
      { x: 49, y: 620 },
      { x: 52, y: 2140 },
      { x: 57, y: 1740 },
      { x: 66, y: 1500 },
      { x: 70, y: 1280 },
      { x: 73, y: 0 },
      { x: 79, y: 0 },
      { x: 84, y: 2860 },
      { x: 92, y: 3440 },
      { x: 100, y: 2640 },
    ],
  },
];

const demoCursor: AnalysisCursor = {
  xPercent: 39,
  summaries: [
    {
      seriesId: 'route-primary',
      color: '#d10000',
      distanceLabel: '127.23 km',
      ascentLabel: '+839 m',
      descentLabel: '-420 m',
      durationLabel: '02:48:59',
      scheduleLabel: 'J1 - 08:29',
    },
    {
      seriesId: 'route-reference-a',
      color: '#ffb54a',
      distanceLabel: '127.23 km',
      ascentLabel: '+1232 m',
      descentLabel: '-339 m',
      durationLabel: '02:31:19',
      scheduleLabel: 'J1 - 08:12',
    },
    {
      seriesId: 'route-reference-b',
      color: '#ffb54a',
      distanceLabel: '127.23 km',
      ascentLabel: '+1232 m',
      descentLabel: '-339 m',
      durationLabel: '02:31:19',
      scheduleLabel: 'J1 - 08:12',
    },
  ],
};

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
        <AnalysisResults series={demoSeries} cursor={demoCursor} />
        <AnalysisSlider />
      </div>
    </div>
  );
}

export default Center;

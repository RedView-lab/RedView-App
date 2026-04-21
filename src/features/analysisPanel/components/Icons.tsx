import { imgIcon, imgIcon1 } from './assets';

export function ChevronDown({ className }: { className?: string }) {
  return (
    <div className={className || "overflow-clip relative size-[20px]"} data-node-id="183:3260" data-name="chevron-down">
      <div className="absolute inset-[45%_36.67%_45%_38.33%]" data-node-id="183:3259" data-name="Icon">
        <div className="absolute inset-[-41.67%_-16.67%]">
          <img alt="" className="block max-w-none size-full" src={imgIcon} />
        </div>
      </div>
    </div>
  );
}

export function Settings({ className }: { className?: string }) {
  return (
    <div className={className || "overflow-clip relative size-[16px]"} data-node-id="693:17789" data-name="settings-04">
      <div className="absolute inset-[20.83%_12.5%]" data-node-id="693:17790" data-name="Icon">
        <div className="absolute inset-[-7.14%_-5.56%]">
          <img alt="" className="block max-w-none size-full" src={imgIcon1} />
        </div>
      </div>
    </div>
  );
}

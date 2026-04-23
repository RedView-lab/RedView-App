import { SvgV2Icon } from '@/components/SvgV2Icon';

export function ChevronDown({ className }: { className?: string }) {
  return (
    <div className={className || 'overflow-clip relative size-[20px]'} data-node-id="183:3260" data-name="chevron-down">
      <SvgV2Icon name="chevron-down.svg" size={20} />
    </div>
  );
}

export function Settings({ className }: { className?: string }) {
  return (
    <div className={className || 'overflow-clip relative size-[16px]'} data-node-id="693:17789" data-name="settings-04">
      <SvgV2Icon name="settings-04.svg" size={16} />
    </div>
  );
}

import { Section } from '../components/Section';
import { IconContourLines } from '../icons';
import type { ControlPanelHandlers } from '../types';

interface Props {
  enabled: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  onEnabledChange?: ControlPanelHandlers['onContourLinesEnabledChange'];
}

export function ContourLinesSection({
  enabled,
  open,
  onOpenChange,
  onEnabledChange,
}: Props) {
  return (
    <Section
      title="Courbes de niveau"
      icon={<IconContourLines size={16} />}
      toggle={{ checked: enabled, onChange: onEnabledChange }}
      open={open}
      onOpenChange={onOpenChange}
    />
  );
}
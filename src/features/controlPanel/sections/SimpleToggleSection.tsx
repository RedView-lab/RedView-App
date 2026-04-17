import { Section } from '../components/Section';

interface Props {
  title: string;
  enabled: boolean;
  onEnabledChange?: (v: boolean) => void;
}

/**
 * Compact collapsible section with only a toggle in the header — used for
 * Vent / Neige / Ensoleillement that have no expanded content in the base design.
 */
export function SimpleToggleSection({ title, enabled, onEnabledChange }: Props) {
  return (
    <Section
      title={title}
      defaultOpen={false}
      toggle={{ checked: enabled, onChange: onEnabledChange }}
    >
      <div className="rvc-simple-section__placeholder" />
    </Section>
  );
}

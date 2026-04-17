interface ComingSoonProps {
  title: string;
  description?: string;
}

export function ComingSoonSection({ title, description }: ComingSoonProps) {
  return (
    <div className="rvi-params">
      <div className="rvi-divider" />
      <h3 className="rvi-section-title">{title}</h3>
      <p style={{ margin: 0, fontSize: 13, opacity: 0.6, fontWeight: 500 }}>
        {description ?? 'Bientôt disponible.'}
      </p>
    </div>
  );
}

interface PayWallProps {
  landingUrl: string;
}

export default function PayWall({ landingUrl }: PayWallProps) {
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        background: "#111",
        color: "#fff",
        fontFamily: "system-ui, sans-serif",
        zIndex: 9999,
      }}
    >
      <h1 style={{ fontSize: "2rem", fontWeight: 600, marginBottom: "0.5rem" }}>
        Subscription required
      </h1>
      <p style={{ color: "#888", marginBottom: "2rem", textAlign: "center", maxWidth: 400 }}>
        You need an active RedView Pro subscription to access the app.
      </p>
      <a
        href={`${landingUrl}/pricing`}
        style={{
          background: "#fff",
          color: "#111",
          padding: "0.75rem 2rem",
          fontSize: "0.875rem",
          fontWeight: 500,
          textDecoration: "none",
          transition: "opacity 0.2s",
        }}
        onMouseEnter={(e) => (e.currentTarget.style.opacity = "0.8")}
        onMouseLeave={(e) => (e.currentTarget.style.opacity = "1")}
      >
        Subscribe — 19.99€/month
      </a>
      <p style={{ color: "#555", fontSize: "0.75rem", marginTop: "1rem" }}>
        Secure payment via Stripe. Cancel anytime.
      </p>
    </div>
  );
}

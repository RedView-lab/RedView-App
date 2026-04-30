export default function PayWall() {
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
        Billing now happens directly inside RedView App. Reconnect with a demo-enabled account or contact support if this access should still be active.
      </p>
      <button
        type="button"
        style={{
          background: "#fff",
          color: "#111",
          border: 0,
          padding: "0.75rem 2rem",
          fontSize: "0.875rem",
          fontWeight: 500,
          cursor: "pointer",
          transition: "opacity 0.2s",
        }}
        onClick={() => window.location.reload()}
        onMouseEnter={(e) => (e.currentTarget.style.opacity = "0.8")}
        onMouseLeave={(e) => (e.currentTarget.style.opacity = "1")}
      >
        Refresh access
      </button>
      <p style={{ color: "#555", fontSize: "0.75rem", marginTop: "1rem" }}>
        Hosted billing pages on the landing page are disabled.
      </p>
    </div>
  );
}

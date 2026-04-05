interface DashboardProps {
  email: string;
  onLogout: () => void;
}

export default function Dashboard({ email, onLogout }: DashboardProps) {
  return (
    <div className="dashboard">
      <header>
        <span className="breadcrumb">
          <span className="accent">RedView</span> {">"} Dashboard
        </span>
        <button onClick={onLogout} className="logout-btn">
          {">"} LOGOUT
        </button>
      </header>

      <main>
        <p className="status">{"> "}connected as <span className="accent">{email}</span></p>
        <div className="test-box">
          <p className="test-label">test</p>
          <p className="test-desc">{"> "}system operational_</p>
        </div>
      </main>

      <footer>
        <p>v0.1.0 — redview app</p>
      </footer>
    </div>
  );
}

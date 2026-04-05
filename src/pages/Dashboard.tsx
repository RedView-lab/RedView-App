interface DashboardProps {
  email: string;
  onLogout: () => void;
}

export default function Dashboard({ email, onLogout }: DashboardProps) {
  return (
    <div className="dashboard">
      <header>
        <span className="logo">RedView</span>
        <button onClick={onLogout} className="logout-btn">
          Logout
        </button>
      </header>

      <main>
        <p className="status">{email}</p>
        <p className="test">test</p>
      </main>
    </div>
  );
}

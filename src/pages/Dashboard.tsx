import { MapView } from '@/features/map3d';

interface DashboardProps {
  email: string;
  onLogout: () => void;
}

export default function Dashboard({ onLogout }: DashboardProps) {
  return (
    <div style={{ position: 'relative', width: '100vw', height: '100dvh' }}>
      <MapView />
      <button
        onClick={onLogout}
        style={{
          position: 'absolute',
          top: 12,
          right: 12,
          zIndex: 20,
          background: 'rgba(17,17,17,0.7)',
          color: 'rgba(255,255,255,0.8)',
          border: '1px solid rgba(255,255,255,0.15)',
          borderRadius: 6,
          padding: '6px 14px',
          fontSize: 12,
          cursor: 'pointer',
          backdropFilter: 'blur(8px)',
        }}
      >
        Logout
      </button>
    </div>
  );
}

import { useState } from 'react';
import { MapView } from '@/features/map3d';
import { LidarPanel } from '@/features/lidar';
import { LidarProvider } from '@/features/lidar/components/LidarContext';

interface DashboardProps {
  email: string;
  onLogout: () => void;
}

export default function Dashboard({ onLogout }: DashboardProps) {
  const [showLidar, setShowLidar] = useState(false);

  return (
    <LidarProvider>
    <div style={{ position: 'relative', width: '100vw', height: '100dvh' }}>
      <MapView />

      {/* LiDAR sidebar */}
      {showLidar && (
        <div style={{
          position: 'absolute',
          top: 0,
          left: 0,
          bottom: 0,
          width: 320,
          background: 'rgba(20, 20, 20, 0.92)',
          backdropFilter: 'blur(12px)',
          borderRight: '1px solid rgba(255,255,255,0.08)',
          zIndex: 15,
          overflowY: 'auto',
        }}>
          <LidarPanel />
        </div>
      )}

      {/* LiDAR toggle button */}
      <button
        onClick={() => setShowLidar(!showLidar)}
        style={{
          position: 'absolute',
          top: 12,
          left: 12,
          zIndex: 20,
          background: showLidar ? 'rgba(59,130,246,0.8)' : 'rgba(17,17,17,0.7)',
          color: 'rgba(255,255,255,0.9)',
          border: '1px solid rgba(255,255,255,0.15)',
          borderRadius: 6,
          padding: '6px 14px',
          fontSize: 12,
          cursor: 'pointer',
          backdropFilter: 'blur(8px)',
          display: 'flex',
          alignItems: 'center',
          gap: 6,
        }}
      >
        🛰️ LiDAR HD
      </button>

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
    </LidarProvider>
  );
}

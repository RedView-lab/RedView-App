import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import LidarViewerPage from './LidarViewerPage';

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    <StrictMode>
      <LidarViewerPage />
    </StrictMode>,
  );
}

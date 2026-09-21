import { useEffect, useState, useCallback } from 'react';

const BYPASS_STORAGE_KEY = 'redview:bypass-mobile-block';

function checkIsMobile(): boolean {
  if (typeof window === 'undefined') return false;

  try {
    if (window.sessionStorage.getItem(BYPASS_STORAGE_KEY) === 'true') {
      return false;
    }
  } catch {
    // Ignore storage access errors
  }

  // Mobile User Agent detection
  const isMobileUA = /Android|webOS|iPhone|iPod|BlackBerry|IEMobile|Opera Mini/i.test(
    navigator.userAgent || '',
  );

  // Screen width threshold (< 960px or mobile UA < 1024px)
  const isNarrowScreen = window.innerWidth < 960;

  return isNarrowScreen || (isMobileUA && window.innerWidth < 1024);
}

export function useIsMobileDevice() {
  const [isMobile, setIsMobile] = useState<boolean>(() => checkIsMobile());

  useEffect(() => {
    const handleResize = () => {
      setIsMobile(checkIsMobile());
    };

    window.addEventListener('resize', handleResize, { passive: true });
    window.addEventListener('orientationchange', handleResize, { passive: true });

    return () => {
      window.removeEventListener('resize', handleResize);
      window.removeEventListener('orientationchange', handleResize);
    };
  }, []);

  const bypassMobileBlock = useCallback(() => {
    try {
      window.sessionStorage.setItem(BYPASS_STORAGE_KEY, 'true');
    } catch {
      // Ignore
    }
    setIsMobile(false);
  }, []);

  return {
    isMobile,
    bypassMobileBlock,
  };
}

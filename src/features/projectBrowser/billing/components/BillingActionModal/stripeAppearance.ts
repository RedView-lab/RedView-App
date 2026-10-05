import type { AppTheme } from '@/shared/lib/appTheme';

// Apparence de l'iframe Stripe Elements (pas d'accès aux variables CSS de l'app).
const darkAppearance = {
  theme: 'night' as const,
  labels: 'above' as const,
  variables: {
    colorPrimary: '#890000',
    colorBackground: '#141414',
    colorText: '#ffffff',
    colorDanger: '#ff8e8e',
    colorTextPlaceholder: '#8c8c8c',
    colorTextSecondary: '#c7c7c7',
    colorIcon: '#d1d1d1',
    colorSuccess: '#34d399',
    borderRadius: '8px',
    spacingUnit: '4px',
    fontFamily: 'Rethink Sans, system-ui, sans-serif',
  },
  rules: {
    '.AccordionItem': {
      backgroundColor: 'rgba(255,255,255,0.04)',
      border: '1px solid rgba(255,255,255,0.16)',
      boxShadow: 'none',
    },
    '.Tab': {
      backgroundColor: 'rgba(255,255,255,0.04)',
      border: '1px solid rgba(255,255,255,0.16)',
      color: '#ffffff',
      boxShadow: 'none',
      padding: '12px 16px',
    },
    '.Tab:hover': {
      color: '#ffffff',
      backgroundColor: 'rgba(255,255,255,0.04)',
    },
    '.Tab--selected': {
      backgroundColor: 'rgba(255,255,255,0.04)',
      borderColor: 'rgba(255,255,255,0.28)',
      boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.08)',
    },
    '.TabLabel': {
      color: '#ffffff',
      fontWeight: '500',
      fontSize: '14px',
    },
    '.Input': {
      backgroundColor: 'rgba(255,255,255,0.08)',
      border: '1px solid rgba(213,215,218,0.16)',
      boxShadow: '0 1px 2px rgba(10,13,18,0.05)',
    },
    '.Block': {
      backgroundColor: 'rgba(255,255,255,0.08)',
      border: '1px solid rgba(213,215,218,0.16)',
      boxShadow: '0 1px 2px rgba(10,13,18,0.05)',
    },
    '.CodeInput': {
      backgroundColor: 'rgba(255,255,255,0.08)',
      border: '1px solid rgba(213,215,218,0.16)',
      boxShadow: '0 1px 2px rgba(10,13,18,0.05)',
    },
    '.Input:focus': {
      borderColor: 'rgba(137,0,0,0.9)',
      boxShadow: '0 0 0 1px rgba(137,0,0,0.65)',
    },
    '.CodeInput:focus': {
      borderColor: 'rgba(137,0,0,0.9)',
      boxShadow: '0 0 0 1px rgba(137,0,0,0.65)',
    },
    // Iframe Stripe : pas d'accès aux variables CSS. Valeurs de l'échelle
    // « page » de shared/styles/typography.css (label lg 14, champ xl 16).
    '.Label': {
      color: '#ffffff',
      fontWeight: '600',
      fontSize: '14px',
    },
    '.Text': {
      color: 'rgba(255,255,255,0.74)',
    },
    '.Error': {
      color: '#ffb4b4',
    },
  },
};

// Thème clair (shared/styles/theme.css) : mêmes rôles, encre #111114 sur blanc.
const lightAppearance = {
  theme: 'stripe' as const,
  labels: 'above' as const,
  variables: {
    ...darkAppearance.variables,
    colorBackground: '#ffffff',
    colorText: '#111114',
    colorDanger: '#d92d20',
    colorTextPlaceholder: '#8a8a8e',
    colorTextSecondary: '#5d5e61',
    colorIcon: '#5d5e61',
    colorSuccess: '#067647',
  },
  rules: {
    '.AccordionItem': {
      backgroundColor: '#ffffff',
      border: '1px solid rgba(17,17,20,0.12)',
      boxShadow: 'none',
    },
    '.Tab': {
      backgroundColor: '#ffffff',
      border: '1px solid rgba(17,17,20,0.12)',
      color: '#111114',
      boxShadow: '0 1px 2px rgba(16,18,24,0.05)',
      padding: '12px 16px',
    },
    '.Tab:hover': {
      color: '#111114',
      backgroundColor: 'rgba(17,17,20,0.03)',
    },
    '.Tab--selected': {
      backgroundColor: '#ffffff',
      borderColor: 'rgba(17,17,20,0.32)',
      boxShadow: 'inset 0 0 0 1px rgba(17,17,20,0.08)',
    },
    '.TabLabel': {
      color: '#111114',
      fontWeight: '500',
      fontSize: '14px',
    },
    '.Input': {
      backgroundColor: '#ffffff',
      border: '1px solid rgba(17,17,20,0.14)',
      boxShadow: '0 1px 2px rgba(16,18,24,0.05)',
    },
    '.Block': {
      backgroundColor: 'rgba(17,17,20,0.03)',
      border: '1px solid rgba(17,17,20,0.1)',
      boxShadow: 'none',
    },
    '.CodeInput': {
      backgroundColor: '#ffffff',
      border: '1px solid rgba(17,17,20,0.14)',
      boxShadow: '0 1px 2px rgba(16,18,24,0.05)',
    },
    '.Input:focus': darkAppearance.rules['.Input:focus'],
    '.CodeInput:focus': darkAppearance.rules['.CodeInput:focus'],
    '.Label': {
      color: '#111114',
      fontWeight: '600',
      fontSize: '14px',
    },
    '.Text': {
      color: 'rgba(17,17,20,0.64)',
    },
    '.Error': {
      color: '#b42318',
    },
  },
};

export function stripeAppearanceFor(theme: AppTheme) {
  return theme === 'light' ? lightAppearance : darkAppearance;
}

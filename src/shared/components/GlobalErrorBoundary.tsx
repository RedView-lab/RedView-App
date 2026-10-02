import { Component, type ErrorInfo, type ReactNode } from 'react';
import * as Sentry from '@sentry/react';
import { logger } from '../lib/logger';
import { translateAppText } from '../i18n';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class GlobalErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    logger.app.error('Uncaught error caught by GlobalErrorBoundary', {
      message: error.message,
      stack: error.stack,
      componentStack: errorInfo.componentStack,
    });
    try {
      Sentry.captureException(error, {
        extra: { componentStack: errorInfo.componentStack },
      });
    } catch {
      // Ignore if Sentry fails to capture
    }
  }

  handleReload = (): void => {
    window.location.reload();
  };

  handleHardReset = (): void => {
    try {
      window.localStorage.removeItem('redview:viewport');
      window.sessionStorage.clear();
    } catch {
      // Ignore
    }
    window.location.reload();
  };

  render(): ReactNode {
    if (this.state.hasError) {
      return (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: '#0c0e12',
            color: '#f8fafc',
            fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
            padding: '24px',
            zIndex: 999999,
          }}
        >
          <div
            style={{
              maxWidth: '460px',
              width: '100%',
              backgroundColor: '#161922',
              border: '1px solid rgba(255, 255, 255, 0.08)',
              borderRadius: '16px',
              padding: '32px 28px',
              textAlign: 'center',
              boxShadow: '0 20px 40px rgba(0, 0, 0, 0.6)',
            }}
          >
            <div style={{ marginBottom: '20px' }}>
              <img
                src="/landing/icons/redview-logo.svg"
                alt="RedView"
                width="120"
                style={{ display: 'inline-block' }}
                onError={(e) => {
                  (e.target as HTMLElement).style.display = 'none';
                }}
              />
            </div>

            <h1
              style={{
                fontSize: 'var(--rv-font-size-2xl)',
                fontWeight: 600,
                color: '#ffffff',
                margin: '0 0 10px 0',
              }}
            >
              {translateAppText("Anomalie d'affichage 3D")}
            </h1>

            <p
              style={{
                fontSize: 'var(--rv-font-size-lg)',
                color: 'rgba(255, 255, 255, 0.65)',
                lineHeight: '22px',
                margin: '0 0 24px 0',
              }}
            >
              {translateAppText(
                "Une erreur inattendue est survenue dans le moteur graphique ou l'interface. Vous pouvez recharger l'application en toute sécurité.",
              )}
            </p>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              <button
                type="button"
                onClick={this.handleReload}
                style={{
                  backgroundColor: '#890000',
                  color: '#ffffff',
                  border: 'none',
                  borderRadius: '10px',
                  padding: '12px 20px',
                  fontSize: 'var(--rv-font-size-lg)',
                  fontWeight: 600,
                  cursor: 'pointer',
                  transition: 'background-color 0.15s ease',
                }}
                onMouseOver={(e) => {
                  (e.target as HTMLElement).style.backgroundColor = '#a30000';
                }}
                onMouseOut={(e) => {
                  (e.target as HTMLElement).style.backgroundColor = '#890000';
                }}
              >
                {translateAppText("Recharger l'application")}
              </button>

              <button
                type="button"
                onClick={this.handleHardReset}
                style={{
                  backgroundColor: 'transparent',
                  color: 'rgba(255, 255, 255, 0.6)',
                  border: '1px solid rgba(255, 255, 255, 0.12)',
                  borderRadius: '10px',
                  padding: '10px 20px',
                  fontSize: 'var(--rv-font-size-md)',
                  cursor: 'pointer',
                }}
              >
                {translateAppText('Réinitialiser la vue et recharger')}
              </button>
            </div>

            {this.state.error && (
              <details
                style={{
                  marginTop: '20px',
                  textAlign: 'left',
                  fontSize: 'var(--rv-font-size-sm)',
                  color: 'rgba(255, 255, 255, 0.4)',
                }}
              >
                <summary style={{ cursor: 'pointer', marginBottom: '8px' }}>
                  {translateAppText('Détails techniques')}
                </summary>
                <pre
                  style={{
                    padding: '10px',
                    borderRadius: '8px',
                    backgroundColor: 'rgba(0, 0, 0, 0.3)',
                    overflowX: 'auto',
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                    color: '#f87171',
                  }}
                >
                  {this.state.error.message}
                </pre>
              </details>
            )}
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

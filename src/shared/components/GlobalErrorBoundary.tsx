import { Component, type ErrorInfo, type ReactNode } from 'react';
import { logger } from '../lib/logger';

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
                fontSize: '20px',
                fontWeight: 600,
                color: '#ffffff',
                margin: '0 0 10px 0',
              }}
            >
              Anomalie d&apos;affichage 3D
            </h1>

            <p
              style={{
                fontSize: '14px',
                color: 'rgba(255, 255, 255, 0.65)',
                lineHeight: '22px',
                margin: '0 0 24px 0',
              }}
            >
              Une erreur inattendue est survenue dans le moteur graphique ou l&apos;interface. Vous
              pouvez recharger l&apos;application en toute sécurité.
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
                  fontSize: '14px',
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
                Recharger l&apos;application
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
                  fontSize: '13px',
                  cursor: 'pointer',
                }}
              >
                Réinitialiser la vue et recharger
              </button>
            </div>

            {this.state.error && (
              <details
                style={{
                  marginTop: '20px',
                  textAlign: 'left',
                  fontSize: '12px',
                  color: 'rgba(255, 255, 255, 0.4)',
                }}
              >
                <summary style={{ cursor: 'pointer', marginBottom: '8px' }}>
                  Détails techniques
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

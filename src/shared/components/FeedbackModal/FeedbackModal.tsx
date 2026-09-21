import { useEffect, useState, useMemo, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import { readStoredAppwriteSession } from '../../services/appwrite';
import { useAppI18n } from '../../i18n';
import { SvgV2Icon } from '../SvgV2Icon';
import './FeedbackModal.css';

export interface FeedbackModalProps {
  open: boolean;
  onClose: () => void;
  defaultCategory?: 'bug' | 'suggestion' | 'feedback';
  defaultFeature?: string;
}

export function FeedbackModal({
  open,
  onClose,
  defaultCategory = 'feedback',
  defaultFeature = 'Général',
}: FeedbackModalProps) {
  const { t } = useAppI18n();

  const [category, setCategory] = useState<'bug' | 'suggestion' | 'feedback'>(defaultCategory);
  const [feature, setFeature] = useState<string>(defaultFeature);
  const [message, setMessage] = useState('');
  const [emailInput, setEmailInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);

  const sessionUser = useMemo(() => {
    try {
      return readStoredAppwriteSession()?.user ?? null;
    } catch {
      return null;
    }
  }, [open]);

  useEffect(() => {
    if (!open) {
      setSubmitted(false);
      setMessage('');
      setError(null);
      setCategory(defaultCategory);
      setFeature(defaultFeature);
    }
  }, [open, defaultCategory, defaultFeature]);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  const categoryPlaceholders = {
    bug: t("Décrivez le comportement inattendu, ce qui s'est passé ou les étapes pour le reproduire..."),
    suggestion: t("Partagez votre idée, un besoin spécifique ou une amélioration pour RedView..."),
    feedback: t("Donnez-nous votre avis sur votre expérience globale ou sur une fonctionnalité précise..."),
  };

  const featureOptions = [
    t('Cartographie 3D'),
    t('Tracés & GPX'),
    t('Météo & Vent'),
    t('Altimétrie'),
    t('Interface'),
    t('Autre'),
  ];

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!message.trim() || message.trim().length < 3) {
      setError(t('Veuillez saisir au moins 3 caractères pour détailler votre retour.'));
      return;
    }

    setLoading(true);
    setError(null);

    const userEmail = sessionUser?.email || emailInput.trim();
    const userName = sessionUser?.name || '';

    try {
      const res = await fetch('/api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type:
            category === 'bug'
              ? 'Bug / Dysfonctionnement'
              : category === 'suggestion'
              ? 'Suggestion d’amélioration'
              : 'Avis général',
          feature,
          message: message.trim(),
          email: userEmail,
          name: userName,
          context: {
            url: window.location.href,
            userAgent: navigator.userAgent,
          },
        }),
      });

      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        throw new Error(errorData.error || t("Erreur lors de l'envoi du message."));
      }

      setSubmitted(true);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : t("Erreur de connexion.");
      setError(msg);
    } finally {
      setLoading(false);
    }
  };

  const modalContent = (
    <div
      className="rv-feedback-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      role="dialog"
      aria-modal="true"
      aria-label={t('Donner un avis ou signaler un bug')}
    >
      <div className="rv-feedback-dialog">
        <div className="rv-feedback-header">
          <div className="rv-feedback-header__left">
            <div className="rv-feedback-header__icon">
              <SvgV2Icon name="annotation.svg" size={18} />
            </div>
            <div>
              <h2 className="rv-feedback-header__title">{t('Donner un avis')}</h2>
              <p className="rv-feedback-header__desc">
                {t('Votre retour façonne directement les évolutions de RedView.')}
              </p>
            </div>
          </div>
          <button
            type="button"
            className="rv-feedback-close-btn"
            onClick={onClose}
            aria-label={t('Fermer')}
          >
            <SvgV2Icon name="x-close.svg" size={18} />
          </button>
        </div>

        {submitted ? (
          <div className="rv-feedback-success">
            <div className="rv-feedback-success__icon">
              <SvgV2Icon name="check.svg" size={24} />
            </div>
            <h3 className="rv-feedback-success__title">{t('Merci pour votre retour !')}</h3>
            <p className="rv-feedback-success__desc">
              {t(
                'Votre message a bien été transmis à l’équipe. Nous lisons attentivement chaque remarque pour perfectionner la plateforme.'
              )}
            </p>
            <button
              type="button"
              className="rv-feedback-btn-submit"
              onClick={onClose}
              style={{ marginTop: 8 }}
            >
              {t('Fermer')}
            </button>
          </div>
        ) : (
          <form onSubmit={handleSubmit}>
            <div className="rv-feedback-body">
              {error ? <div className="rv-feedback-error">{error}</div> : null}

              <div className="rv-feedback-group">
                <label className="rv-feedback-label">{t('Type de retour')}</label>
                <div className="rv-feedback-segmented">
                  <button
                    type="button"
                    className={`rv-feedback-pill${category === 'bug' ? ' is-active' : ''}`}
                    onClick={() => setCategory('bug')}
                  >
                    <span>🐛</span>
                    <span>{t('Bug')}</span>
                  </button>
                  <button
                    type="button"
                    className={`rv-feedback-pill${category === 'suggestion' ? ' is-active' : ''}`}
                    onClick={() => setCategory('suggestion')}
                  >
                    <span>💡</span>
                    <span>{t('Idée')}</span>
                  </button>
                  <button
                    type="button"
                    className={`rv-feedback-pill${category === 'feedback' ? ' is-active' : ''}`}
                    onClick={() => setCategory('feedback')}
                  >
                    <span>⭐</span>
                    <span>{t('Avis')}</span>
                  </button>
                </div>
              </div>

              <div className="rv-feedback-group">
                <label className="rv-feedback-label">{t('Section concernée')}</label>
                <div className="rv-feedback-feature-row">
                  {featureOptions.map((opt) => (
                    <button
                      key={opt}
                      type="button"
                      className={`rv-feedback-feature-tag${feature === opt ? ' is-active' : ''}`}
                      onClick={() => setFeature(opt)}
                    >
                      {opt}
                    </button>
                  ))}
                </div>
              </div>

              <div className="rv-feedback-group">
                <label className="rv-feedback-label">{t('Votre message')}</label>
                <textarea
                  className="rv-feedback-textarea"
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  placeholder={categoryPlaceholders[category]}
                  rows={4}
                  maxLength={2500}
                  required
                  autoFocus
                />
                <div className="rv-feedback-meta">
                  {sessionUser?.email ? (
                    <div className="rv-feedback-user-info" title={sessionUser.email}>
                      <SvgV2Icon name="user-circle.svg" size={13} />
                      <span>{sessionUser.name || sessionUser.email}</span>
                    </div>
                  ) : (
                    <span>{t('Optionnel :')}</span>
                  )}
                  <span>{message.length} / 2500</span>
                </div>
              </div>

              {!sessionUser?.email ? (
                <div className="rv-feedback-group">
                  <label className="rv-feedback-label">{t('Votre e-mail (optionnel)')}</label>
                  <input
                    type="email"
                    className="rv-feedback-input"
                    value={emailInput}
                    onChange={(e) => setEmailInput(e.target.value)}
                    placeholder="nom@exemple.com"
                  />
                </div>
              ) : null}
            </div>

            <div className="rv-feedback-footer">
              <button
                type="button"
                className="rv-feedback-btn-cancel"
                onClick={onClose}
                disabled={loading}
              >
                {t('Annuler')}
              </button>
              <button
                type="submit"
                className="rv-feedback-btn-submit"
                disabled={loading || message.trim().length < 3}
              >
                {loading ? (
                  <span>{t('Envoi...')}</span>
                ) : (
                  <>
                    <SvgV2Icon name="annotation.svg" size={15} />
                    <span>{t('Envoyer')}</span>
                  </>
                )}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );

  if (typeof document === 'undefined') return null;
  return createPortal(modalContent, document.body);
}

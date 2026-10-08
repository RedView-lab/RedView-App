import { useState, useRef, useEffect, type ChangeEvent, type KeyboardEvent, type ClipboardEvent } from 'react';
import { useAppI18n } from '@/shared/i18n';
import { errorMessage as thrownMessage } from '@/shared/lib/errors';
import './VerificationCodeModal.css';

interface VerificationCodeModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: (code: string) => Promise<{ success: boolean; error?: string }>;
  onResend: () => Promise<{ success: boolean; error?: string }>;
}

const CODE_LENGTH = 6;
const CODE_REGEX = /^\d{6}$/;
const emptyDigits = (): string[] => Array.from({ length: CODE_LENGTH }, () => '');
// La feuille de style d'origine dimensionne 4 cases de 80 px ; on resserre
// en inline pour que 6 cases tiennent dans la carte (360 px de contenu).
const DIGITS_ROW_STYLE = { gap: 8 } as const;
const DIGIT_INPUT_STYLE = {
  width: 52,
  height: 60,
  minWidth: 52,
  minHeight: 60,
  fontSize: 'var(--rv-font-size-4xl)',
  lineHeight: '60px',
} as const;

export default function VerificationCodeModal({
  isOpen,
  onClose,
  onConfirm,
  onResend,
}: VerificationCodeModalProps) {
  // La carte est un sous-arbre `data-rv-no-translate` : l'observer DOM ne la
  // traduit pas, tous les textes passent donc par t().
  const { t } = useAppI18n();
  const [digits, setDigits] = useState<string[]>(emptyDigits);
  const [loading, setLoading] = useState(false);
  const [resending, setResending] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [countdown, setCountdown] = useState(30);

  const inputsRef = useRef<(HTMLInputElement | null)[]>([]);

  // Focus sur le premier champ à l'ouverture et lancement du compte à rebours
  useEffect(() => {
    if (isOpen) {
      setDigits(emptyDigits());
      setErrorMessage(null);
      setCountdown(30);
      const timer = setTimeout(() => {
        inputsRef.current[0]?.focus();
      }, 50);
      return () => clearTimeout(timer);
    }
  }, [isOpen]);

  // Minuteur du compte à rebours de renvoi
  useEffect(() => {
    if (!isOpen || countdown <= 0) return;
    const interval = setInterval(() => {
      setCountdown((prev) => (prev > 0 ? prev - 1 : 0));
    }, 1000);
    return () => clearInterval(interval);
  }, [isOpen, countdown]);

  if (!isOpen) return null;

  const handleInputChange = (index: number, e: ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setErrorMessage(null);

    // Ne garde que les chiffres
    const cleaned = val.replace(/\D/g, '');

    // Gère le collage dans une seule case ou une saisie normale
    if (cleaned.length > 1) {
      const chars = cleaned.slice(0, CODE_LENGTH).split('');
      const newDigits = [...digits];
      chars.forEach((ch, idx) => {
        if (index + idx < CODE_LENGTH) {
          newDigits[index + idx] = ch;
        }
      });
      setDigits(newDigits);
      const nextFocus = Math.min(index + chars.length, CODE_LENGTH - 1);
      inputsRef.current[nextFocus]?.focus();

      // Les 6 chiffres saisis : envoi automatique
      if (newDigits.every((d) => d !== '')) {
        verify(newDigits.join(''));
      }
      return;
    }

    const digit = cleaned.slice(-1);
    const newDigits = [...digits];
    newDigits[index] = digit;
    setDigits(newDigits);

    if (digit && index < CODE_LENGTH - 1) {
      inputsRef.current[index + 1]?.focus();
    }

    // Envoi automatique au dernier (6e) chiffre
    if (digit && index === CODE_LENGTH - 1 && newDigits.every((d) => d !== '')) {
      verify(newDigits.join(''));
    }
  };

  const handleKeyDown = (index: number, e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Backspace') {
      if (!digits[index] && index > 0) {
        inputsRef.current[index - 1]?.focus();
        const newDigits = [...digits];
        newDigits[index - 1] = '';
        setDigits(newDigits);
      } else {
        const newDigits = [...digits];
        newDigits[index] = '';
        setDigits(newDigits);
      }
    } else if (e.key === 'ArrowLeft' && index > 0) {
      inputsRef.current[index - 1]?.focus();
    } else if (e.key === 'ArrowRight' && index < CODE_LENGTH - 1) {
      inputsRef.current[index + 1]?.focus();
    } else if (e.key === 'Enter') {
      verify(digits.join(''));
    }
  };

  const handlePaste = (e: ClipboardEvent<HTMLInputElement>) => {
    e.preventDefault();
    const pasted = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, CODE_LENGTH);
    if (!pasted) return;

    const chars = pasted.split('');
    const newDigits = emptyDigits();
    chars.forEach((c, idx) => {
      newDigits[idx] = c;
    });
    setDigits(newDigits);

    const focusIdx = Math.min(chars.length, CODE_LENGTH - 1);
    inputsRef.current[focusIdx]?.focus();

    if (chars.length === CODE_LENGTH) {
      verify(newDigits.join(''));
    }
  };

  const verify = async (code: string) => {
    if (!CODE_REGEX.test(code)) {
      setErrorMessage('Veuillez renseigner les 6 chiffres du code.');
      return;
    }

    setErrorMessage(null);
    setLoading(true);

    try {
      const res = await onConfirm(code);
      if (!res.success) {
        setErrorMessage(res.error || 'Code invalide.');
        inputsRef.current[0]?.focus();
      }
    } catch (err) {
      setErrorMessage(thrownMessage(err, 'Erreur lors de la validation du code.'));
      inputsRef.current[0]?.focus();
    } finally {
      setLoading(false);
    }
  };

  const handleResend = async () => {
    if (countdown > 0 || resending) return;
    setResending(true);
    setErrorMessage(null);

    try {
      const res = await onResend();
      if (res.success) {
        setCountdown(30);
        setDigits(emptyDigits());
        inputsRef.current[0]?.focus();
      } else {
        setErrorMessage(res.error || 'Impossible de renvoyer le code.');
      }
    } catch (err) {
      setErrorMessage(thrownMessage(err, 'Erreur lors du renvoi du code.'));
    } finally {
      setResending(false);
    }
  };

  return (
    <div className="rv-modal-backdrop rv-fixed-viewport" role="dialog" aria-modal="true">
      {/* Fond de la surcouche */}
      <div className="rv-modal-overlay" onClick={onClose} />

      {/* Carte de la fenêtre */}
      <div className="rv-modal-card" data-rv-no-translate="true" translate="no">
        {/* En-tête de la fenêtre */}
        <header className="rv-modal-header">
          {/* Icône mise en avant */}
          <div className="rv-modal-featured-icon">
            <svg
              width="24"
              height="24"
              viewBox="0 0 24 24"
              fill="none"
              stroke="#FFFFFF"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <rect width="20" height="16" x="2" y="4" rx="2" />
              <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" />
            </svg>
          </div>

          {/* Bouton de fermeture X */}
          <button
            type="button"
            className="rv-modal-close-btn"
            onClick={onClose}
            aria-label={t('Fermer')}
          >
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>

          {/* Texte et texte d'accompagnement */}
          <div className="rv-modal-text-group">
            <h2 className="rv-modal-title">{t('Vérifiez vos e-mails.')}</h2>
            <p className="rv-modal-supporting-text">
              {t('Si l’adresse est valide, nous vous avons envoyé un e-mail avec un code de confirmation à 6 chiffres.')}
            </p>
          </div>
        </header>

        {/* Content */}
        <div className="rv-modal-content">
          {/* Message d'erreur */}
          {errorMessage && <div className="rv-modal-error">{t(errorMessage)}</div>}

          {/* Rangée de 6 grands champs */}
          <div className="rv-modal-digits-row" style={DIGITS_ROW_STYLE}>
            {digits.map((digit, idx) => (
              <input
                key={idx}
                ref={(el) => {
                  inputsRef.current[idx] = el;
                }}
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                maxLength={CODE_LENGTH}
                value={digit}
                onChange={(e) => handleInputChange(idx, e)}
                onKeyDown={(e) => handleKeyDown(idx, e)}
                onPaste={handlePaste}
                disabled={loading}
                className={`rv-mega-input ${errorMessage ? 'is-error' : ''}`}
                style={DIGIT_INPUT_STYLE}
                autoComplete="one-time-code"
                aria-label={t('Chiffre {{index}}', { index: idx + 1 })}
              />
            ))}
          </div>

          {/* Texte d'aide / renvoi */}
          <div className="rv-modal-hint-row">
            <span className="rv-modal-hint-label">{t("Vous n'avez rien reçu ?")}</span>
            {countdown > 0 ? (
              <span className="rv-modal-hint-countdown">
                {t('Cliquez ici pour renvoyer ({{seconds}}s)', { seconds: countdown })}
              </span>
            ) : (
              <button
                type="button"
                className="rv-modal-resend-btn"
                onClick={handleResend}
                disabled={resending}
              >
                {resending ? t('Envoi...') : t('Cliquez ici pour renvoyer')}
              </button>
            )}
          </div>
        </div>

        {/* Actions de la fenêtre */}
        <div className="rv-modal-actions">
          {/* Cancel */}
          <button
            type="button"
            className="rv-modal-btn-cancel"
            onClick={onClose}
            disabled={loading}
          >
            {t('Annuler')}
          </button>

          {/* Verify */}
          <button
            type="button"
            className="rv-modal-btn-confirm"
            onClick={() => verify(digits.join(''))}
            disabled={loading || digits.some((d) => !d)}
          >
            {loading ? <div className="rv-modal-spinner" /> : t('Vérifier')}
          </button>
        </div>
      </div>
    </div>
  );
}

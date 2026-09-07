import { useState, useRef, useEffect, type ChangeEvent, type KeyboardEvent, type ClipboardEvent } from 'react';
import './VerificationCodeModal.css';

interface VerificationCodeModalProps {
  isOpen: boolean;
  email: string;
  debugCode?: string;
  onClose: () => void;
  onConfirm: (code: string) => Promise<{ success: boolean; error?: string }>;
  onResend: () => Promise<{ success: boolean; debugCode?: string; error?: string }>;
}

export default function VerificationCodeModal({
  isOpen,
  email,
  debugCode: initialDebugCode,
  onClose,
  onConfirm,
  onResend,
}: VerificationCodeModalProps) {
  const [digits, setDigits] = useState<string[]>(['', '', '', '']);
  const [loading, setLoading] = useState(false);
  const [resending, setResending] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [countdown, setCountdown] = useState(60);
  const [debugCode, setDebugCode] = useState<string | undefined>(initialDebugCode);

  const inputsRef = useRef<(HTMLInputElement | null)[]>([]);

  useEffect(() => {
    setDebugCode(initialDebugCode);
  }, [initialDebugCode]);

  // Focus first input on open & start countdown
  useEffect(() => {
    if (isOpen) {
      setDigits(['', '', '', '']);
      setErrorMessage(null);
      setCountdown(60);
      const timer = setTimeout(() => {
        inputsRef.current[0]?.focus();
      }, 50);
      return () => clearTimeout(timer);
    }
  }, [isOpen]);

  // Resend countdown timer
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

    // Filter only numeric characters
    const cleaned = val.replace(/\D/g, '');

    // Handle paste inside single box or normal input
    if (cleaned.length > 1) {
      const chars = cleaned.slice(0, 4).split('');
      const newDigits = [...digits];
      chars.forEach((ch, idx) => {
        if (index + idx < 4) {
          newDigits[index + idx] = ch;
        }
      });
      setDigits(newDigits);
      const nextFocus = Math.min(index + chars.length, 3);
      inputsRef.current[nextFocus]?.focus();

      // If full 4 digits reached, auto submit
      if (newDigits.every((d) => d !== '')) {
        verify(newDigits.join(''));
      }
      return;
    }

    const digit = cleaned.slice(-1);
    const newDigits = [...digits];
    newDigits[index] = digit;
    setDigits(newDigits);

    if (digit && index < 3) {
      inputsRef.current[index + 1]?.focus();
    }

    // Auto submit on 4th digit
    if (digit && index === 3 && newDigits.every((d) => d !== '')) {
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
    } else if (e.key === 'ArrowRight' && index < 3) {
      inputsRef.current[index + 1]?.focus();
    } else if (e.key === 'Enter') {
      verify(digits.join(''));
    }
  };

  const handlePaste = (e: ClipboardEvent<HTMLInputElement>) => {
    e.preventDefault();
    const pasted = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, 4);
    if (!pasted) return;

    const chars = pasted.split('');
    const newDigits = ['', '', '', ''];
    chars.forEach((c, idx) => {
      newDigits[idx] = c;
    });
    setDigits(newDigits);

    const focusIdx = Math.min(chars.length, 3);
    inputsRef.current[focusIdx]?.focus();

    if (chars.length === 4) {
      verify(newDigits.join(''));
    }
  };

  const verify = async (code: string) => {
    if (code.length < 4) {
      setErrorMessage('Veuillez renseigner les 4 chiffres du code.');
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
    } catch (err: any) {
      setErrorMessage(err?.message || 'Erreur lors de la validation du code.');
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
        setCountdown(60);
        setDigits(['', '', '', '']);
        inputsRef.current[0]?.focus();
        if (res.debugCode) {
          setDebugCode(res.debugCode);
        }
      } else {
        setErrorMessage(res.error || 'Impossible de renvoyer le code.');
      }
    } catch (err: any) {
      setErrorMessage(err?.message || 'Erreur lors du renvoi du code.');
    } finally {
      setResending(false);
    }
  };

  return (
    <div className="rv-modal-backdrop" role="dialog" aria-modal="true">
      {/* Background overlay */}
      <div className="rv-modal-overlay" onClick={onClose} />

      {/* Modal Card */}
      <div className="rv-modal-card">
        {/* Background pattern decorative */}
        <div className="rv-modal-decorative-glow" />

        {/* Modal header */}
        <header className="rv-modal-header">
          {/* Featured icon */}
          <div className="rv-modal-featured-icon">
            <svg
              width="24"
              height="24"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <rect width="20" height="16" x="2" y="4" rx="2" />
              <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" />
            </svg>
          </div>

          {/* Close button X */}
          <button
            type="button"
            className="rv-modal-close-btn"
            onClick={onClose}
            aria-label="Fermer"
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

          {/* Text and supporting text */}
          <div className="rv-modal-text-group">
            <h2 className="rv-modal-title">Vérifiez votre e-mail</h2>
            <p className="rv-modal-supporting-text">
              Nous avons envoyé un code de vérification à <strong>{email}</strong>
            </p>
          </div>
        </header>

        {/* Content */}
        <div className="rv-modal-content">
          {/* Error Message */}
          {errorMessage && <div className="rv-modal-error">{errorMessage}</div>}

          {/* Debug hint if in development or no SMTP configured */}
          {debugCode && (
            <div className="rv-modal-debug-hint">
              Code de test : <strong>{debugCode}</strong> (SMTP non configuré)
            </div>
          )}

          {/* 4 Mega inputs row */}
          <div className="rv-modal-digits-row">
            {digits.map((digit, idx) => (
              <input
                key={idx}
                ref={(el) => {
                  inputsRef.current[idx] = el;
                }}
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                maxLength={4}
                value={digit}
                onChange={(e) => handleInputChange(idx, e)}
                onKeyDown={(e) => handleKeyDown(idx, e)}
                onPaste={handlePaste}
                disabled={loading}
                className={`rv-mega-input ${errorMessage ? 'is-error' : ''}`}
                autoComplete="one-time-code"
                aria-label={`Chiffre ${idx + 1}`}
              />
            ))}
          </div>

          {/* Hint text / Resend */}
          <div className="rv-modal-hint-row">
            <span>Vous n'avez pas reçu le code ?</span>
            {countdown > 0 ? (
              <span>Renvoyer ({countdown}s)</span>
            ) : (
              <button
                type="button"
                className="rv-modal-resend-btn"
                onClick={handleResend}
                disabled={resending}
              >
                {resending ? 'Envoi...' : 'Renvoyer'}
              </button>
            )}
          </div>
        </div>

        {/* Modal actions */}
        <div className="rv-modal-actions">
          {/* Cancel */}
          <button
            type="button"
            className="rv-modal-btn-cancel"
            onClick={onClose}
            disabled={loading}
          >
            Annuler
          </button>

          {/* Confirm */}
          <button
            type="button"
            className="rv-modal-btn-confirm"
            onClick={() => verify(digits.join(''))}
            disabled={loading || digits.some((d) => !d)}
          >
            {loading ? <div className="rv-modal-spinner" /> : 'Confirmer'}
          </button>
        </div>
      </div>
    </div>
  );
}

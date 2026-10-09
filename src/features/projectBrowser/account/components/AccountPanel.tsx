import { useEffect, useMemo, useRef, useState } from 'react';

import { useHasChanged } from '@/shared/hooks/useHasChanged';
import { useAppI18n } from '@/shared/i18n';

import {
  DEFAULT_COUNTRY,
  DEFAULT_LEVEL,
  DEFAULT_SPORT,
} from '../lib/options';
import {
  formatAccountDisplayName,
  saveAccountIdentity,
  saveAccountPractice,
  updateAccountPassword,
} from '../lib/profile';
import type {
  AccountIdentityForm,
  AccountPracticeForm,
  AccountProfile,
} from '../types';
import { AccountDataForm } from './AccountDataForm';
import { AccountIdentityForm as AccountIdentitySection } from './AccountIdentityForm';
import type { AccountPasswordValue } from '../lib/passwordForm';
import { AccountPasswordForm } from './AccountPasswordForm';
import { AccountPracticeForm as AccountPracticeSection } from './AccountPracticeForm';

type AccountPanelProps = {
  profile: AccountProfile | null;
  isLoading: boolean;
  error: string | null;
  fallbackDisplayName: string;
  onProfileUpdated: (nextProfile: AccountProfile) => void;
};

type NoticeState = {
  tone: 'success' | 'error';
  message: string;
} | null;

function createIdentityForm(profile: AccountProfile | null): AccountIdentityForm {
  return {
    firstName: profile?.firstName ?? '',
    lastName: profile?.lastName ?? '',
    email: profile?.email ?? '',
  };
}

function createPracticeForm(profile: AccountProfile | null): AccountPracticeForm {
  return {
    country: profile?.country ?? DEFAULT_COUNTRY,
    sports:
      profile?.sports.length
        ? profile.sports
        : [
            {
              id: 'sport-1',
              sport: DEFAULT_SPORT,
              level: DEFAULT_LEVEL,
              annualDistanceKm: '500',
            },
          ],
  };
}

const EMPTY_PASSWORD: AccountPasswordValue = { current: '', next: '', confirm: '' };

function serializePracticeForm(value: AccountPracticeForm) {
  return JSON.stringify(value);
}

export function AccountPanel({
  profile,
  isLoading,
  error,
  fallbackDisplayName,
  onProfileUpdated,
}: AccountPanelProps) {
  const [identityForm, setIdentityForm] = useState<AccountIdentityForm>(() => createIdentityForm(profile));
  const [practiceForm, setPracticeForm] = useState<AccountPracticeForm>(() => createPracticeForm(profile));
  const [password, setPassword] = useState<AccountPasswordValue>(EMPTY_PASSWORD);
  const [identitySaving, setIdentitySaving] = useState(false);
  const [practiceSaving, setPracticeSaving] = useState(false);
  const [passwordSaving, setPasswordSaving] = useState(false);
  const [notice, setNotice] = useState<NoticeState>(null);
  const { t } = useAppI18n();
  const syncedPracticeRef = useRef(serializePracticeForm(createPracticeForm(profile)));
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Nouveau profil : formulaires repartis de lui (au premier rendu, l'état initial en vient déjà).
  if (useHasChanged(profile)) {
    setIdentityForm(createIdentityForm(profile));
    setPracticeForm(createPracticeForm(profile));
  }

  useEffect(() => {
    syncedPracticeRef.current = serializePracticeForm(createPracticeForm(profile));
  }, [profile]);

  const profileDisplayName = useMemo(() => {
    if (!profile) return fallbackDisplayName;
    return formatAccountDisplayName(profile, fallbackDisplayName);
  }, [fallbackDisplayName, profile]);

  useEffect(() => {
    if (!profile) return;
    const serialized = serializePracticeForm(practiceForm);
    if (serialized === syncedPracticeRef.current) return;

    setPracticeSaving(true);
    const timeoutId = window.setTimeout(() => {
      void (async () => {
        try {
          await saveAccountPractice(practiceForm);
          syncedPracticeRef.current = serialized;
          onProfileUpdated({
            ...profile,
            country: practiceForm.country,
            sports: practiceForm.sports,
          });
        } catch (nextError) {
          if (mountedRef.current) {
            setNotice({
              tone: 'error',
              message:
                nextError instanceof Error
                  ? t(nextError.message)
                  : t('Impossible d’enregistrer les informations de pratique.'),
            });
          }
        } finally {
          if (mountedRef.current) setPracticeSaving(false);
        }
      })();
    }, 500);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [onProfileUpdated, practiceForm, profile]);

  const handleIdentitySave = async () => {
    if (!profile) return;
    setIdentitySaving(true);
    setNotice(null);
    try {
      const nextUser = await saveAccountIdentity(identityForm);
      onProfileUpdated({
        ...profile,
        firstName: identityForm.firstName.trim(),
        lastName: identityForm.lastName.trim(),
        email: nextUser.email ?? identityForm.email.trim(),
      });
      setNotice({
        tone: 'success',
        message: t('Coordonnees enregistrees.'),
      });
    } catch (nextError) {
      setNotice({
        tone: 'error',
        message:
          nextError instanceof Error ? t(nextError.message) : t('Impossible d’enregistrer le compte.'),
      });
    } finally {
      setIdentitySaving(false);
    }
  };

  const handlePasswordSave = async () => {
    setPasswordSaving(true);
    setNotice(null);
    try {
      await updateAccountPassword(password.next, profile?.hasPassword ? password.current : undefined);
      setPassword(EMPTY_PASSWORD);
      // Compte Google : il a maintenant un mot de passe (l'actuel sera demandé la prochaine fois).
      if (profile && !profile.hasPassword) onProfileUpdated({ ...profile, hasPassword: true });
      setNotice({
        tone: 'success',
        message: t('Mot de passe mis a jour.'),
      });
    } catch (nextError) {
      setNotice({
        tone: 'error',
        message:
          nextError instanceof Error
            ? t(nextError.message)
            : t('Impossible de mettre a jour le mot de passe.'),
      });
    } finally {
      setPasswordSaving(false);
    }
  };

  if (isLoading) {
    return (
      <section className="rvpb-account-panel" aria-label={t('Compte')}>
        <div className="rvpb-empty">{t('Chargement du compte...')}</div>
      </section>
    );
  }

  if (error) {
    return (
      <section className="rvpb-account-panel" aria-label={t('Compte')}>
        <div className="rvpb-error" role="alert">
          {t(error)}
        </div>
      </section>
    );
  }

  if (!profile) {
    return (
      <section className="rvpb-account-panel" aria-label={t('Compte')}>
        <div className="rvpb-empty">{t('Aucune information de compte disponible.')}</div>
      </section>
    );
  }

  return (
    <section className="rvpb-account-panel" aria-label={`${t('Compte')} ${profileDisplayName}`}>
      {notice ? (
        <div className={`rvpb-account-notice is-${notice.tone}`} role={notice.tone === 'error' ? 'alert' : 'status'}>
          {notice.message}
        </div>
      ) : null}

      <AccountIdentitySection
        value={identityForm}
        initialValue={createIdentityForm(profile)}
        isSaving={identitySaving}
        hasPassword={profile.hasPassword}
        onEmailChanged={(email) => {
          onProfileUpdated({ ...profile, email });
          setNotice({ tone: 'success', message: t('Adresse e-mail changée : {{email}}', { email }) });
        }}
        onChange={setIdentityForm}
        onCancel={() => setIdentityForm(createIdentityForm(profile))}
        onSave={() => {
          void handleIdentitySave();
        }}
      />

      <div className="rvpb-divider" />

      <AccountPracticeSection
        value={practiceForm}
        isSaving={practiceSaving}
        onChange={setPracticeForm}
        onAddSport={() =>
          setPracticeForm((prev) => ({
            ...prev,
            sports: [
              ...prev.sports,
              {
                id: `sport-${prev.sports.length + 1}`,
                sport: DEFAULT_SPORT,
                level: DEFAULT_LEVEL,
                annualDistanceKm: '500',
              },
            ],
          }))
        }
      />

      <div className="rvpb-divider" />

      <AccountPasswordForm
        value={password}
        hasPassword={profile.hasPassword}
        isSaving={passwordSaving}
        onChange={setPassword}
        onSave={() => {
          void handlePasswordSave();
        }}
      />

      <div className="rvpb-divider" />

      <AccountDataForm email={profile.email} />
    </section>
  );
}
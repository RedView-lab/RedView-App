import { useEffect, useMemo, useRef, useState } from 'react';

import {
  DEFAULT_COUNTRY,
  DEFAULT_LEVEL,
  DEFAULT_SPORT,
} from './options';
import {
  formatAccountDisplayName,
  saveAccountIdentity,
  saveAccountPractice,
  updateAccountPassword,
} from './profile';
import type {
  AccountIdentityForm,
  AccountPracticeForm,
  AccountProfile,
} from './types';
import { AccountIdentityForm as AccountIdentitySection } from './AccountIdentityForm';
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
  const [password, setPassword] = useState('');
  const [identitySaving, setIdentitySaving] = useState(false);
  const [practiceSaving, setPracticeSaving] = useState(false);
  const [passwordSaving, setPasswordSaving] = useState(false);
  const [notice, setNotice] = useState<NoticeState>(null);
  const syncedPracticeRef = useRef(serializePracticeForm(createPracticeForm(profile)));
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    setIdentityForm(createIdentityForm(profile));
    const nextPractice = createPracticeForm(profile);
    setPracticeForm(nextPractice);
    syncedPracticeRef.current = serializePracticeForm(nextPractice);
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
                  ? nextError.message
                  : 'Impossible d’enregistrer les informations de pratique.',
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
        message: 'Coordonnees enregistrees.',
      });
    } catch (nextError) {
      setNotice({
        tone: 'error',
        message:
          nextError instanceof Error ? nextError.message : 'Impossible d’enregistrer le compte.',
      });
    } finally {
      setIdentitySaving(false);
    }
  };

  const handlePasswordSave = async () => {
    setPasswordSaving(true);
    setNotice(null);
    try {
      await updateAccountPassword(password.trim());
      setPassword('');
      setNotice({
        tone: 'success',
        message: 'Mot de passe mis a jour.',
      });
    } catch (nextError) {
      setNotice({
        tone: 'error',
        message:
          nextError instanceof Error
            ? nextError.message
            : 'Impossible de mettre a jour le mot de passe.',
      });
    } finally {
      setPasswordSaving(false);
    }
  };

  if (isLoading) {
    return (
      <section className="rvpb-account-panel" aria-label="Compte">
        <div className="rvpb-empty">Chargement du compte...</div>
      </section>
    );
  }

  if (error) {
    return (
      <section className="rvpb-account-panel" aria-label="Compte">
        <div className="rvpb-error" role="alert">
          {error}
        </div>
      </section>
    );
  }

  if (!profile) {
    return (
      <section className="rvpb-account-panel" aria-label="Compte">
        <div className="rvpb-empty">Aucune information de compte disponible.</div>
      </section>
    );
  }

  return (
    <section className="rvpb-account-panel" aria-label={`Compte ${profileDisplayName}`}>
      {notice ? (
        <div className={`rvpb-account-notice is-${notice.tone}`} role={notice.tone === 'error' ? 'alert' : 'status'}>
          {notice.message}
        </div>
      ) : null}

      <AccountIdentitySection
        value={identityForm}
        initialValue={createIdentityForm(profile)}
        isSaving={identitySaving}
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
        isSaving={passwordSaving}
        onChange={setPassword}
        onSave={() => {
          void handlePasswordSave();
        }}
      />
    </section>
  );
}
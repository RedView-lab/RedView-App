import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { verificationStoreDir } from '../verificationStore';

afterEach(() => vi.unstubAllEnvs());

describe('verificationStoreDir (A13-1)', () => {
  it('REDVIEW_AUTH_STORE_DIR (volume persistant) : créé au besoin et utilisé', () => {
    const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rv-auth-store-')), 'data');
    vi.stubEnv('REDVIEW_AUTH_STORE_DIR', dir);
    expect(verificationStoreDir()).toBe(dir);
    expect(fs.statSync(dir).isDirectory()).toBe(true);
  });

  it('sans réglage : le dossier temporaire (dev, tests)', () => {
    vi.stubEnv('REDVIEW_AUTH_STORE_DIR', '');
    expect(verificationStoreDir()).toBe(os.tmpdir());
  });
});

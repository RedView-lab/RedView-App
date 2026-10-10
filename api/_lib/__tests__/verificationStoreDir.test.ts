import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

vi.mock('../mailer.ts', () => ({
  sendVerificationEmail: vi.fn(async () => ({ sent: true })),
  sendAccountDeletionCodeEmail: vi.fn(async () => ({ sent: true })),
  sendEmailChangeCodeEmail: vi.fn(async () => ({ sent: true })),
}));

describe('verificationStore (A13-1)', () => {
  it('écrit codes et verrous dans REDVIEW_AUTH_STORE_DIR (volume persistant), pas dans /tmp', async () => {
    const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rv-auth-store-')), 'data');
    vi.stubEnv('REDVIEW_AUTH_STORE_DIR', dir);
    const store = await import('../verificationStore');
    store.consumeVerificationRequestQuota('persist@example.test');
    await new Promise((resolve) => setTimeout(resolve, 400));
    const file = path.join(dir, 'redview_auth_verification_vault.json');
    expect(fs.existsSync(file)).toBe(true);
    expect(JSON.parse(fs.readFileSync(file, 'utf-8')).quotas['persist@example.test'].requests).toHaveLength(1);
    vi.unstubAllEnvs();
  });
});

import { describe, expect, it, vi } from 'vitest';

const call = vi.fn();
vi.mock('@/shared/services/appwrite', () => ({
  APPWRITE_DATABASE_ID: 'db',
  PROJECT_VIEWS_COLLECTION_ID: 'project_views',
  client: { config: { endpoint: 'https://appwrite.example/v1', project: 'redview-test' }, call: (...args: unknown[]) => call(...args) },
  databases: {},
  ID: { unique: () => 'id' },
  Permission: {},
  Query: { limit: (n: number) => `limit(${n})`, cursorAfter: (id: string) => `cursorAfter(${id})` },
  Role: {},
}));

const { myProjectTeams } = await import('./accessQueries');

describe('myProjectTeams', () => {
  it('names the project on its raw GET /teams (SDK v26 no longer does): without it Appwrite answers for its console and CORS blocks it', async () => {
    call.mockResolvedValueOnce({ teams: [{ $id: 'p123' }, { $id: 'other-team' }], total: 2 });
    await expect(myProjectTeams('user-1', { fresh: true })).resolves.toEqual(new Set(['p123']));
    const [method, url, headers] = call.mock.calls[0]! as [string, URL, Record<string, string>];
    expect(method).toBe('get');
    expect(url.toString()).toBe('https://appwrite.example/v1/teams');
    expect(headers['X-Appwrite-Project']).toBe('redview-test');
  });
});

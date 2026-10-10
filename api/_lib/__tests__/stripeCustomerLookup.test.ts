import { beforeEach, describe, expect, it, vi } from 'vitest';

const fakes = vi.hoisted(() => ({
  rows: [] as { user_id: string; stripe_customer_id: string }[],
  users: new Map<string, { labels: string[] }>(),
}));

vi.mock('../appwrite.js', () => ({
  APPWRITE_DATABASE_ID: 'db',
  CUSTOMERS_COLLECTION_ID: 'customers',
  getAppwriteDatabases: () => ({
    listDocuments: async (_db: string, _collection: string, queries: string[]) => {
      const wanted = JSON.parse(queries[0]).values[0];
      return { documents: fakes.rows.filter((row) => row.stripe_customer_id === wanted) };
    },
  }),
  getAppwriteUsers: () => ({
    get: async (id: string) => {
      const user = fakes.users.get(id);
      if (!user) throw Object.assign(new Error('User not found'), { code: 404 });
      return user;
    },
  }),
}));
vi.mock('../stripe.js', () => ({ getStripeServer: () => ({}) }));

const { getUserIdFromCustomer } = await import('../billing/customers');

beforeEach(() => {
  fakes.rows = [{ user_id: 'u1', stripe_customer_id: 'cus_1' }];
  fakes.users = new Map([['u1', { labels: [] }]]);
});

describe('getUserIdFromCustomer (A2-2)', () => {
  it('compte actif : retrouvé', async () => {
    expect(await getUserIdFromCustomer('cus_1')).toBe('u1');
    expect(await getUserIdFromCustomer('cus_x')).toBeNull();
  });

  it('compte en cours de suppression ou déjà supprimé : aucun compte, le webhook ne recrée rien', async () => {
    fakes.users.set('u1', { labels: ['deletionpending'] });
    expect(await getUserIdFromCustomer('cus_1')).toBeNull();
    fakes.users.delete('u1');
    expect(await getUserIdFromCustomer('cus_1')).toBeNull();
  });

  it('Appwrite en panne : l’erreur remonte (Stripe relivre l’évènement)', async () => {
    fakes.users = new Map();
    vi.spyOn(fakes.users, 'get').mockImplementation(() => { throw Object.assign(new Error('down'), { code: 503 }); });
    await expect(getUserIdFromCustomer('cus_1')).rejects.toThrow('down');
  });
});

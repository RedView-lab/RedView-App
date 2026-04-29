import type Stripe from 'stripe';

import { getSupabaseAdmin } from '../supabase.js';
import { getStripeServer } from '../stripe.js';
import type { CustomerRow } from './types.js';

function isMissingStripeCustomerError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }

  const candidate = error as {
    code?: string;
    param?: string;
    message?: string;
  };

  return (
    candidate.code === 'resource_missing' &&
    (candidate.param === 'customer' ||
      candidate.message?.toLowerCase().includes('no such customer') === true)
  );
}

export function isStripeCustomer(
  customer: Stripe.Customer | Stripe.DeletedCustomer,
): customer is Stripe.Customer {
  return !customer.deleted;
}

async function createAndStoreStripeCustomer(userId: string, email: string | null): Promise<string> {
  const customer = await getStripeServer().customers.create({
    ...(email ? { email } : {}),
    metadata: { supabase_user_id: userId },
  });

  const { error: upsertError } = await getSupabaseAdmin().from('customers').upsert(
    {
      id: userId,
      stripe_customer_id: customer.id,
    },
    {
      onConflict: 'id',
    },
  );

  if (upsertError) {
    throw upsertError;
  }

  return customer.id;
}

export async function getValidatedStripeCustomerId(
  stripeCustomerId: string,
): Promise<string | null> {
  try {
    const customer = await getStripeServer().customers.retrieve(stripeCustomerId);
    return customer.deleted ? null : customer.id;
  } catch (error) {
    if (isMissingStripeCustomerError(error)) {
      return null;
    }

    throw error;
  }
}

export async function getOrCreateStripeCustomer(
  userId: string,
  email: string | null,
): Promise<string> {
  const admin = getSupabaseAdmin();

  const { data: existing, error } = await admin
    .from('customers')
    .select('stripe_customer_id')
    .eq('id', userId)
    .maybeSingle<{ stripe_customer_id: string | null }>();

  if (error) {
    throw error;
  }

  if (existing?.stripe_customer_id) {
    const validatedCustomerId = await getValidatedStripeCustomerId(existing.stripe_customer_id);
    if (validatedCustomerId) {
      return validatedCustomerId;
    }
  }

  return createAndStoreStripeCustomer(userId, email);
}

export async function getCustomerRow(userId: string): Promise<CustomerRow | null> {
  const admin = getSupabaseAdmin();
  const detailedQuery = await admin
    .from('customers')
    .select('stripe_customer_id, billing_email_mode, billing_email')
    .eq('id', userId)
    .maybeSingle<CustomerRow>();

  if (!detailedQuery.error) {
    return detailedQuery.data ?? null;
  }

  const message = detailedQuery.error.message.toLowerCase();
  if (!message.includes('billing_email')) {
    throw detailedQuery.error;
  }

  const fallbackQuery = await admin
    .from('customers')
    .select('stripe_customer_id')
    .eq('id', userId)
    .maybeSingle<{ stripe_customer_id: string | null }>();

  if (fallbackQuery.error) {
    throw fallbackQuery.error;
  }

  return fallbackQuery.data ?? null;
}

export async function getStripeCustomerId(userId: string): Promise<string | null> {
  const row = await getCustomerRow(userId);
  if (!row?.stripe_customer_id) {
    return null;
  }

  return getValidatedStripeCustomerId(row.stripe_customer_id);
}

export async function getUserIdFromCustomer(stripeCustomerId: string): Promise<string | null> {
  const { data, error } = await getSupabaseAdmin()
    .from('customers')
    .select('id')
    .eq('stripe_customer_id', stripeCustomerId)
    .maybeSingle<{ id: string }>();

  if (error) {
    throw error;
  }

  return data?.id ?? null;
}
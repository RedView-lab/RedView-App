type BillingDebugPayload = Record<string, unknown>;

function serializeError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack ?? null,
    };
  }

  return {
    value: error,
  };
}

export function logBillingUi(
  event: string,
  payload: BillingDebugPayload = {},
  summary?: string,
) {
  if (summary) {
    console.info('[billing-ui]', event, summary, payload);
    return;
  }

  console.info('[billing-ui]', event, payload);
}

export function logBillingUiError(
  event: string,
  error: unknown,
  payload: BillingDebugPayload = {},
  summary?: string,
) {
  const serialized = {
    ...payload,
    error: serializeError(error),
  };

  if (summary) {
    console.error('[billing-ui]', event, summary, serialized);
    return;
  }

  console.error('[billing-ui]', event, serialized);
}
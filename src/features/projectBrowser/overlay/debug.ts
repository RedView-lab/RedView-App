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

export function logBillingUi(event: string, payload: BillingDebugPayload = {}) {
  console.info('[billing-ui]', event, payload);
}

export function logBillingUiError(
  event: string,
  error: unknown,
  payload: BillingDebugPayload = {},
) {
  console.error('[billing-ui]', event, {
    ...payload,
    error: serializeError(error),
  });
}
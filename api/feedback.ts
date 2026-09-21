import type { ApiRequest, ApiResponse } from './_lib/types.js';
import { sendFeedbackNotificationEmail } from './_lib/mailer.js';

interface FeedbackRequestBody {
  type?: string;
  feature?: string;
  message?: string;
  email?: string;
  name?: string;
  context?: {
    url?: string;
    userAgent?: string;
  };
}

export default async function handler(req: ApiRequest, res: ApiResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed. Use POST.' });
  }

  const body = (req.body || {}) as FeedbackRequestBody;
  const { type = 'Avis général', feature = 'Général', message = '', email = '', name = '', context } = body;

  if (!message || typeof message !== 'string' || message.trim().length < 3) {
    return res.status(400).json({ error: 'Veuillez saisir un message valide (au moins 3 caractères).' });
  }

  try {
    const result = await sendFeedbackNotificationEmail({
      type: String(type).slice(0, 50),
      feature: String(feature).slice(0, 100),
      message: String(message).slice(0, 3000),
      email: typeof email === 'string' ? email.slice(0, 150) : '',
      name: typeof name === 'string' ? name.slice(0, 100) : '',
      context: {
        url: typeof context?.url === 'string' ? context.url.slice(0, 200) : undefined,
        userAgent: typeof context?.userAgent === 'string' ? context.userAgent.slice(0, 250) : undefined,
      },
    });

    return res.status(200).json({
      success: true,
      message: 'Votre retour a bien été enregistré. Merci !',
      delivered: result.sent,
    });
  } catch (error: unknown) {
    console.error('[API Feedback Error]:', error);
    return res.status(500).json({ error: 'Erreur lors du traitement de votre retour.' });
  }
}

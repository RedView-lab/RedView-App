import nodemailer from 'nodemailer';

interface SendVerificationEmailOptions {
  to: string;
  code: string;
  name?: string;
}

let transporter: nodemailer.Transporter | null = null;

function getTransporter(): nodemailer.Transporter | null {
  if (transporter) return transporter;

  const host = process.env.SMTP_HOST;
  const port = parseInt(process.env.SMTP_PORT || '587', 10);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  const secure = process.env.SMTP_SECURE === 'true' || port === 465;

  if (!host || !user || !pass) {
    return null;
  }

  transporter = nodemailer.createTransport({
    host,
    port,
    secure,
    auth: {
      user,
      pass,
    },
  });

  return transporter;
}

export async function sendVerificationEmail({
  to,
  code,
  name,
}: SendVerificationEmailOptions): Promise<{ sent: boolean; debugCode?: string }> {
  const mailTransporter = getTransporter();
  const from = process.env.SMTP_FROM || 'RedView <noreply@redview.app>';
  const recipientName = name || to.split('@')[0] || 'Aventurier';

  console.log(`[AUTH] 📧 Verification code for ${to} (${recipientName}): [ ${code} ]`);

  if (!mailTransporter) {
    console.log('[AUTH] (Note: SMTP not configured. Code logged to console & returned in debugCode)');
    return { sent: false, debugCode: code };
  }

  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Votre code de vérification RedView</title>
  <style>
    body {
      background-color: #0d0d0d;
      color: #ffffff;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
      margin: 0;
      padding: 40px 20px;
    }
    .container {
      max-width: 460px;
      margin: 0 auto;
      background: #141414;
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 16px;
      padding: 36px 28px;
      text-align: center;
      box-shadow: 0 10px 30px rgba(0, 0, 0, 0.5);
    }
    .logo {
      margin-bottom: 24px;
    }
    h1 {
      font-size: 22px;
      font-weight: 600;
      color: #ffffff;
      margin: 0 0 10px 0;
    }
    p {
      color: rgba(255, 255, 255, 0.7);
      font-size: 14px;
      line-height: 22px;
      margin: 0 0 24px 0;
    }
    .code-container {
      display: inline-block;
      margin: 10px auto 24px;
      padding: 16px 28px;
      background: rgba(137, 0, 0, 0.15);
      border: 2px solid #890000;
      border-radius: 12px;
      font-size: 38px;
      font-weight: 700;
      letter-spacing: 12px;
      color: #ffffff;
      text-align: center;
    }
    .footer {
      font-size: 12px;
      color: rgba(255, 255, 255, 0.4);
      margin-top: 24px;
      border-top: 1px solid rgba(255, 255, 255, 0.08);
      padding-top: 20px;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="logo">
      <img src="https://app.141.145.220.99.sslip.io/landing/icons/redview-logo.svg" alt="RedView" width="130" style="display:block;margin:0 auto;" />
    </div>
    <h1>Vérifiez votre adresse e-mail</h1>
    <p>Bonjour <strong>${recipientName}</strong>,<br>Voici votre code de sécurité pour finaliser la création de votre compte RedView :</p>
    
    <div class="code-container">${code}</div>

    <p style="font-size: 13px; color: rgba(255, 255, 255, 0.5);">Ce code est valable pendant 10 minutes.</p>
    
    <div class="footer">
      Si vous n'avez pas initié cette inscription, vous pouvez ignorer cet e-mail en toute sécurité.<br>
      © RedView — La cartographie 3D Haute Définition
    </div>
  </div>
</body>
</html>
  `.trim();

  try {
    await mailTransporter.sendMail({
      from,
      to,
      subject: `${code} est votre code de vérification RedView`,
      text: `Votre code de vérification RedView est : ${code}. Il expire dans 10 minutes.`,
      html,
    });
    return { sent: true };
  } catch (err) {
    console.error('[AUTH] Failed to send email via SMTP:', err);
    return { sent: false, debugCode: code };
  }
}

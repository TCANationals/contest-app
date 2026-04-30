// AWS SES email adapter (§7.4.3). Lazy-loaded only when SES_FROM_ADDRESS is
// set, so test runs without SES credentials don't pull in the SDK.

export interface EmailPayload {
  to: string;
  subject: string;
  body: string;
  listUnsubscribeMailto?: string;
  listUnsubscribeUrl?: string;
}

export interface SesConfig {
  fromAddress: string;
  region: string;
  configurationSet?: string;
}

export function loadSesConfig(): SesConfig | null {
  const fromAddress = process.env.SES_FROM_ADDRESS;
  const region = process.env.AWS_REGION;
  if (!fromAddress || !region) return null;
  return {
    fromAddress,
    region,
    configurationSet: process.env.SES_CONFIGURATION_SET || undefined,
  };
}

interface SesClientLike {
  send: (cmd: unknown) => Promise<{ MessageId?: string }>;
}

let clientPromise: Promise<SesClientLike> | null = null;
async function getClient(cfg: SesConfig): Promise<SesClientLike> {
  if (!clientPromise) {
    clientPromise = (async () => {
      const { SESv2Client } = (await import('@aws-sdk/client-sesv2')) as {
        SESv2Client: new (args: { region: string }) => SesClientLike;
      };
      return new SESv2Client({ region: cfg.region });
    })();
  }
  return clientPromise;
}

export async function sendEmail(
  payload: EmailPayload,
  cfg: SesConfig | null = loadSesConfig(),
): Promise<{ messageId: string }> {
  if (!cfg) throw new Error('ses_not_configured');
  const { SendEmailCommand } = (await import('@aws-sdk/client-sesv2')) as {
    SendEmailCommand: new (input: unknown) => unknown;
  };

  const headers: Array<{ Name: string; Value: string }> = [];
  const unsubParts: string[] = [];
  if (payload.listUnsubscribeMailto) unsubParts.push(`<mailto:${payload.listUnsubscribeMailto}>`);
  if (payload.listUnsubscribeUrl) unsubParts.push(`<${payload.listUnsubscribeUrl}>`);
  if (unsubParts.length > 0) {
    headers.push({ Name: 'List-Unsubscribe', Value: unsubParts.join(', ') });
    headers.push({ Name: 'List-Unsubscribe-Post', Value: 'List-Unsubscribe=One-Click' });
  }

  const cmd = new SendEmailCommand({
    FromEmailAddress: cfg.fromAddress,
    Destination: { ToAddresses: [payload.to] },
    Content: {
      Simple: {
        Subject: { Data: payload.subject, Charset: 'UTF-8' },
        Body: {
          Text: { Data: payload.body, Charset: 'UTF-8' },
        },
        Headers: headers.length > 0 ? headers : undefined,
      },
    },
    ConfigurationSetName: cfg.configurationSet,
  });

  const client = await getClient(cfg);
  const res = await client.send(cmd);
  return { messageId: res.MessageId ?? '' };
}

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export function isEmailAddress(email: string): boolean {
  return EMAIL_REGEX.test(email);
}

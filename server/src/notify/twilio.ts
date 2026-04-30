// Twilio SMS adapter (§7.4.2). Lazy-loaded only when TWILIO_ACCOUNT_SID is
// set, so test runs without Twilio credentials don't pull in the SDK.

export interface SmsPayload {
  to: string;
  body: string;
}

export interface TwilioConfig {
  accountSid: string;
  authToken: string;
  fromNumber: string;
}

export function loadTwilioConfig(): TwilioConfig | null {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const fromNumber = process.env.TWILIO_FROM_NUMBER;
  if (!accountSid || !authToken || !fromNumber) return null;
  return { accountSid, authToken, fromNumber };
}

let clientPromise: Promise<unknown> | null = null;
async function getClient(cfg: TwilioConfig): Promise<{
  messages: { create: (args: { to: string; from: string; body: string }) => Promise<{ sid: string }> };
}> {
  if (!clientPromise) {
    clientPromise = (async () => {
      const mod = (await import('twilio')) as unknown as {
        default: (sid: string, token: string) => unknown;
      };
      return mod.default(cfg.accountSid, cfg.authToken);
    })();
  }
  return clientPromise as Promise<{
    messages: {
      create: (args: { to: string; from: string; body: string }) => Promise<{ sid: string }>;
    };
  }>;
}

export async function sendSms(
  payload: SmsPayload,
  cfg: TwilioConfig | null = loadTwilioConfig(),
): Promise<{ sid: string }> {
  if (!cfg) throw new Error('twilio_not_configured');
  const client = await getClient(cfg);
  const msg = await client.messages.create({
    to: payload.to,
    from: cfg.fromNumber,
    body: payload.body,
  });
  return { sid: msg.sid };
}

export const E164_REGEX = /^\+[1-9]\d{6,14}$/;

export function isE164(phone: string): boolean {
  return E164_REGEX.test(phone);
}

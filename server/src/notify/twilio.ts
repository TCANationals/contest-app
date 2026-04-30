// Twilio SMS adapter (§7.4.2). Stub.
//
// TODO: lazy-load the `twilio` package; send via Programmable Messaging.

export interface SmsPayload {
  to: string;
  body: string;
}

export async function sendSms(_payload: SmsPayload): Promise<{ sid: string }> {
  throw new Error('sendSms: not implemented');
}

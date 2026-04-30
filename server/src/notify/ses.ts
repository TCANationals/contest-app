// AWS SES email adapter (§7.4.3). Stub.
//
// TODO: lazy-load @aws-sdk/client-sesv2; send via SendEmailCommand with
// List-Unsubscribe headers and the configured SES_CONFIGURATION_SET.

export interface EmailPayload {
  to: string;
  subject: string;
  body: string;
}

export async function sendEmail(
  _payload: EmailPayload,
): Promise<{ messageId: string }> {
  throw new Error('sendEmail: not implemented');
}

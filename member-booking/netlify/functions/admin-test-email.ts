import { buildContext } from '../../src/domain/context.ts';
import { createProvider } from '../../src/lib/email.ts';
import { requireAdmin } from '../../src/lib/auth.ts';
import { env } from '../../src/lib/env.ts';
import { errorResponse, json, preflight, requireMethod } from '../../src/lib/http.ts';

/**
 * POST /api/admin/test-email
 *
 * Sends one real message to the signed-in admin's own address and reports what
 * the provider said.
 *
 * Email configuration fails quietly by design everywhere else: a send failure
 * must never take a booking down with it, so the booking succeeds and the
 * failure goes to a log nobody is watching. That is right for production and
 * useless for setup, where the only question is "did the credentials work".
 * This endpoint answers that question directly.
 *
 * It deliberately bypasses the outbox and the swallow-and-queue path, and
 * returns the provider's own error text. That text can be blunt (Gmail's
 * "Username and Password not accepted" for a plain account password used
 * instead of an app password, for instance) and blunt is what makes it
 * fixable. Admin-only, and it only ever sends to the caller's own address, so
 * it cannot be used to mail anybody else.
 */
export default async (request: Request): Promise<Response> => {
  const early = preflight(request);
  if (early) return early;

  try {
    requireMethod(request, 'POST');
    await buildContext();
    const staff = requireAdmin(request);

    const provider = createProvider();
    if (provider.name === 'console') {
      return json(request, {
        ok: false,
        provider: 'console',
        message:
          'No email provider is configured, so nothing is delivered. Set EMAIL_PROVIDER and its credentials, then try again.',
      });
    }

    const sentAt = new Date().toISOString();
    try {
      const result = await provider.send({
        to: staff.email,
        subject: 'Alchemy member booking: email is working',
        text: [
          `This is a test from the Alchemy member booking channel, sent at ${sentAt}.`,
          '',
          `Provider: ${provider.name}`,
          `From: ${env.emailFrom}`,
          '',
          'If you are reading this, sign-in links, guest waivers and cancellation',
          'notices will all reach people. Nothing further to do.',
        ].join('\n'),
        html: `<p>This is a test from the Alchemy member booking channel, sent at ${sentAt}.</p>
               <p>Provider: <strong>${provider.name}</strong><br>From: ${env.emailFrom}</p>
               <p>If you are reading this, sign-in links, guest waivers and cancellation notices will all reach people. Nothing further to do.</p>`,
      });

      return json(request, {
        ok: true,
        provider: provider.name,
        sentTo: staff.email,
        providerId: result.providerId,
        message: `Sent to ${staff.email} via ${provider.name}. If it arrives, email is working.`,
      });
    } catch (error) {
      // The provider's own words, because they are what makes this fixable.
      const detail = error instanceof Error ? error.message : String(error);
      return json(request, {
        ok: false,
        provider: provider.name,
        error: detail,
        message: `${provider.name} refused the message. ${hint(detail)}`,
      });
    }
  } catch (error) {
    return errorResponse(request, error);
  }
};

/** Turns the common provider errors into the thing to actually go and change. */
function hint(detail: string): string {
  const text = detail.toLowerCase();
  if (text.includes('username and password not accepted') || text.includes('invalid login') || text.includes('535')) {
    return 'That usually means an ordinary account password was used. Gmail needs an app password, generated under Google Account, Security, 2-Step Verification, App passwords.';
  }
  if (text.includes('econnrefused') || text.includes('etimedout') || text.includes('enotfound')) {
    return 'The SMTP host or port could not be reached. Check SMTP_HOST and SMTP_PORT: 465 for implicit TLS, 587 for STARTTLS.';
  }
  if (text.includes('403') || text.includes('401') || text.includes('unauthorized')) {
    return 'The API key was rejected. Check EMAIL_API_KEY.';
  }
  if (text.includes('from') || text.includes('sender') || text.includes('domain')) {
    return 'The sending address was rejected. It usually has to match the authenticated mailbox, or a domain verified with the provider.';
  }
  return 'Check the credentials for this provider in the Netlify environment variables.';
}

export const config = { path: '/api/admin/test-email' };

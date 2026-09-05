import { env } from './env.ts';
import type { Store } from '../store/types.ts';

/**
 * Transactional email.
 *
 * Every send is written to email_outbox first and marked sent afterwards, so a
 * provider outage degrades to a queue rather than a lost waiver. PRD 8: if the
 * email provider is down, the booking still succeeds.
 */

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface EmailProvider {
  name: string;
  send(message: EmailMessage): Promise<{ providerId: string | null }>;
}

class ConsoleProvider implements EmailProvider {
  name = 'console';
  async send(message: EmailMessage): Promise<{ providerId: string | null }> {
    console.log(`[email:console] to=${message.to} subject=${message.subject}\n${message.text}`);
    return { providerId: null };
  }
}

class PostmarkProvider implements EmailProvider {
  name = 'postmark';
  async send(message: EmailMessage): Promise<{ providerId: string | null }> {
    const response = await fetch('https://api.postmarkapp.com/email', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        'X-Postmark-Server-Token': env.emailApiKey,
      },
      body: JSON.stringify({
        From: env.emailFrom,
        To: message.to,
        Subject: message.subject,
        TextBody: message.text,
        HtmlBody: message.html,
        MessageStream: 'outbound',
      }),
    });
    if (!response.ok) throw new Error(`Postmark ${response.status}: ${await response.text()}`);
    const body = (await response.json()) as { MessageID?: string };
    return { providerId: body.MessageID ?? null };
  }
}

class ResendProvider implements EmailProvider {
  name = 'resend';
  async send(message: EmailMessage): Promise<{ providerId: string | null }> {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${env.emailApiKey}` },
      body: JSON.stringify({
        from: env.emailFrom,
        to: [message.to],
        subject: message.subject,
        text: message.text,
        html: message.html,
      }),
    });
    if (!response.ok) throw new Error(`Resend ${response.status}: ${await response.text()}`);
    const body = (await response.json()) as { id?: string };
    return { providerId: body.id ?? null };
  }
}

/**
 * SMTP, for sending through a mailbox the business already owns.
 *
 * The reason this exists: Postmark and Resend both require signing up for a
 * new vendor, whereas Alchemy already sends mail from Google Workspace. With
 * an app password this needs no new account, no new domain reputation, and no
 * monthly cost, and messages come from the address members already recognise.
 *
 * Gmail's limits (a couple of thousand recipients a day on Workspace) are far
 * above what one venue's bookings will ever generate.
 */
class SmtpProvider implements EmailProvider {
  name = 'smtp';
  async send(message: EmailMessage): Promise<{ providerId: string | null }> {
    // Imported lazily so the dependency is only loaded when SMTP is selected,
    // keeping it out of the bundle for deployments using an HTTP provider.
    const nodemailer = await import('nodemailer');
    const { host, port, user, pass, secure } = env.smtp;

    const transport = nodemailer.createTransport({
      host,
      port,
      secure,
      auth: { user, pass },
    });

    const info = await transport.sendMail({
      from: env.emailFrom,
      to: message.to,
      subject: message.subject,
      text: message.text,
      html: message.html,
    });
    return { providerId: info.messageId ?? null };
  }
}

export function createProvider(): EmailProvider {
  switch (env.emailProvider) {
    case 'postmark':
      return new PostmarkProvider();
    case 'resend':
      return new ResendProvider();
    case 'smtp':
      return new SmtpProvider();
    default:
      return new ConsoleProvider();
  }
}

/**
 * Queue then attempt. Returns immediately on provider failure: the caller must
 * not treat a failed send as a failed booking.
 */
export async function sendQueued(
  store: Store,
  template: string,
  message: EmailMessage,
  payload: Record<string, unknown> = {},
): Promise<void> {
  const emailId = await store.outbox.enqueue({
    toEmail: message.to,
    template,
    payload: { subject: message.subject, ...payload },
  });
  try {
    const { providerId } = await createProvider().send(message);
    await store.outbox.markSent(emailId, providerId);
  } catch (error) {
    console.error(`[member-booking] email send failed (queued for retry) template=${template}`, error);
    await store.outbox.markFailed(emailId, error instanceof Error ? error.message : String(error));
  }
}

/* ------------------------------------------------------------------ */
/* Templates                                                           */
/* ------------------------------------------------------------------ */

/**
 * The site's colours, on a light ground.
 *
 * The brand is near-black and the screens follow it, but a dark HTML email
 * is the one place that does not travel: several clients invert or strip
 * background colours and leave pale text on white. So the palette is the
 * brand's, with the values the right way up for a mail client.
 */
const BRAND = {
  name: 'alchemy saunas',
  ground: '#f4efe7',
  ink: '#0c0a09',
  accent: '#8a5a2b',
  muted: '#796f64',
  line: '#ddd3c6',
};

function layout(title: string, bodyHtml: string): string {
  return `<!doctype html><html><body style="margin:0;background:${BRAND.ground};font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:${BRAND.ink}">
  <div style="max-width:560px;margin:0 auto;padding:40px 24px">
    <p style="font-size:12px;letter-spacing:.32em;color:${BRAND.muted};margin:0 0 32px">${BRAND.name}</p>
    <h1 style="font-family:Georgia,'Times New Roman',serif;font-style:italic;font-weight:400;font-size:28px;line-height:1.2;margin:0 0 20px;color:${BRAND.ink}">${title}</h1>
    ${bodyHtml}
    <p style="font-size:12px;color:${BRAND.muted};margin-top:40px;border-top:1px solid ${BRAND.line};padding-top:20px;line-height:1.6">
      Alchemy East Fremantle. If you have a question about this booking, reply to this email or speak to the team at the venue.
    </p>
  </div></body></html>`;
}

export function bookingConfirmation(input: {
  memberName: string;
  venueName: string;
  sessionLabel: string;
  spotsTotal: number;
  guestNames: string[];
  amountOwed: number;
  cutoffHours: number;
  manageUrl: string;
}): EmailMessage {
  const guestLine =
    input.guestNames.length > 0
      ? `Guests: ${input.guestNames.join(', ')}`
      : 'No guests on this booking.';
  const owedLine =
    input.amountOwed > 0
      ? `Amount owed: $${input.amountOwed.toFixed(2)}, payable by EFTPOS at the venue when you arrive. There is nothing to pay online.`
      : 'Nothing to pay: your member spot is included in your membership.';

  const text = [
    `Hi ${input.memberName},`,
    '',
    `You're booked at ${input.venueName}.`,
    '',
    `Session: ${input.sessionLabel}`,
    `Spots: ${input.spotsTotal}`,
    guestLine,
    owedLine,
    '',
    `Cancellation: free up to ${input.cutoffHours} hours before the session starts. After that, contact the venue.`,
    input.guestNames.length > 0
      ? 'Each guest has been emailed their own waiver. They need to sign it before arriving, or they can sign at the door.'
      : '',
    '',
    `Manage this booking: ${input.manageUrl}`,
  ]
    .filter(Boolean)
    .join('\n');

  const html = layout(
    "You're booked in",
    `<p style="margin:0 0 16px">Hi ${escapeHtml(input.memberName)}, your spot at ${escapeHtml(input.venueName)} is confirmed.</p>
     <table style="width:100%;border-collapse:collapse;font-size:15px;margin:0 0 20px">
       <tr><td style="padding:8px 0;color:${BRAND.muted}">Session</td><td style="padding:8px 0;text-align:right"><strong>${escapeHtml(input.sessionLabel)}</strong></td></tr>
       <tr><td style="padding:8px 0;color:${BRAND.muted}">Spots</td><td style="padding:8px 0;text-align:right"><strong>${input.spotsTotal}</strong></td></tr>
       ${input.guestNames.length > 0 ? `<tr><td style="padding:8px 0;color:${BRAND.muted}">Guests</td><td style="padding:8px 0;text-align:right">${escapeHtml(input.guestNames.join(', '))}</td></tr>` : ''}
       <tr><td style="padding:8px 0;color:${BRAND.muted}">To pay at the door</td><td style="padding:8px 0;text-align:right"><strong>$${input.amountOwed.toFixed(2)}</strong></td></tr>
     </table>
     <p style="margin:0 0 16px;font-size:14px">${escapeHtml(owedLine)}</p>
     <p style="margin:0 0 16px;font-size:14px">Free cancellation up to ${input.cutoffHours} hours before the session starts.</p>
     ${input.guestNames.length > 0 ? `<p style="margin:0 0 16px;font-size:14px">Each guest has been emailed their own waiver.</p>` : ''}
     <p style="margin:24px 0 0"><a href="${input.manageUrl}" style="background:${BRAND.accent};color:#fff;padding:12px 20px;border-radius:6px;text-decoration:none;display:inline-block">Manage booking</a></p>`,
  );

  return { to: '', subject: `Booked: ${input.sessionLabel} at ${input.venueName}`, text, html };
}

export function waiverInvite(input: {
  guestName: string;
  memberName: string;
  venueName: string;
  sessionLabel: string;
  waiverUrl: string;
  isReminder: boolean;
}): EmailMessage {
  const opener = input.isReminder
    ? `A reminder: your waiver for tomorrow's session at ${input.venueName} is not signed yet.`
    : `${input.memberName} has booked you a spot at ${input.venueName}.`;

  const text = [
    `Hi ${input.guestName},`,
    '',
    opener,
    '',
    `Session: ${input.sessionLabel}`,
    '',
    'Before you visit, please read and sign the waiver:',
    input.waiverUrl,
    '',
    'It takes about a minute. If you would rather sign at the venue, the team can sort it out at the door.',
    '',
    'A guest spot is $35, collected by card at the venue.',
  ].join('\n');

  const html = layout(
    input.isReminder ? 'Your waiver is still unsigned' : 'Your guest spot at Alchemy',
    `<p style="margin:0 0 16px">Hi ${escapeHtml(input.guestName)}, ${escapeHtml(opener)}</p>
     <p style="margin:0 0 16px;font-size:15px"><strong>${escapeHtml(input.sessionLabel)}</strong></p>
     <p style="margin:0 0 16px;font-size:14px">Please read and sign the waiver before you visit. It takes about a minute.</p>
     <p style="margin:24px 0"><a href="${input.waiverUrl}" style="background:${BRAND.accent};color:#fff;padding:12px 20px;border-radius:6px;text-decoration:none;display:inline-block">Read and sign the waiver</a></p>
     <p style="margin:0;font-size:14px;color:${BRAND.muted}">A guest spot is $35, collected by card at the venue.</p>`,
  );

  return {
    to: '',
    subject: input.isReminder ? `Reminder: sign your waiver for ${input.sessionLabel}` : `Your guest spot at ${input.venueName}`,
    text,
    html,
  };
}

export function cancellationNotice(input: {
  recipientName: string;
  venueName: string;
  sessionLabel: string;
  cancelledByMember: boolean;
  memberName: string;
}): EmailMessage {
  const reason = input.cancelledByMember
    ? `${input.memberName} has cancelled the booking.`
    : 'The booking has been cancelled.';
  const text = [
    `Hi ${input.recipientName},`,
    '',
    `${reason} Your spot at ${input.venueName} for ${input.sessionLabel} has been released.`,
    '',
    'Nothing was charged, so there is nothing to refund.',
  ].join('\n');

  const html = layout(
    'Your booking was cancelled',
    `<p style="margin:0 0 16px">Hi ${escapeHtml(input.recipientName)}, ${escapeHtml(reason)}</p>
     <p style="margin:0 0 16px;font-size:15px">Your spot for <strong>${escapeHtml(input.sessionLabel)}</strong> at ${escapeHtml(input.venueName)} has been released.</p>
     <p style="margin:0;font-size:14px;color:${BRAND.muted}">Nothing was charged, so there is nothing to refund.</p>`,
  );

  return { to: '', subject: `Cancelled: ${input.sessionLabel}`, text, html };
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

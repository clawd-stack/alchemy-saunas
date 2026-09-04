import { buildContext } from '../../src/domain/context.ts';
import { sendWaiverReminders } from '../../src/domain/waivers.ts';

/**
 * Scheduled hourly. Sends one reminder per unsigned waiver, 24 hours out.
 * The reminder_sent_at column keeps it to one per waiver however often the
 * job runs, so a retry or an overlapping run cannot spam a guest.
 */
export default async (): Promise<Response> => {
  const context = await buildContext();
  const sent = await sendWaiverReminders(context);
  console.log(`[member-booking] waiver reminders sent: ${sent}`);
  return new Response(JSON.stringify({ ok: true, sent }), {
    headers: { 'content-type': 'application/json' },
  });
};

export const config = { schedule: '@hourly' };

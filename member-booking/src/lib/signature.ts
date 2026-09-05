import { BookingError } from './errors.ts';

/**
 * Drawn signatures.
 *
 * A signature is stored as SVG path data in a fixed coordinate space rather
 * than as an image. It is a few hundred bytes instead of tens of kilobytes, it
 * stays sharp at any size, and because nothing survives validation except
 * digits, spaces and the two path commands, drawing it back onto a page can
 * never introduce markup.
 *
 * The coordinate space is fixed here and mirrored in web/waiver.js. The pad is
 * held to the same aspect ratio in CSS, so a signature is captured and redrawn
 * at the same proportions whatever the size of the screen it was signed on.
 */

export const SIGNATURE_WIDTH = 1000;
export const SIGNATURE_HEIGHT = 400;

/** Roughly 1,300 points. Longer than any signature, short enough to be a cheap column. */
const MAX_LENGTH = 16_000;

/** "M12 34L56 78M90 12", integers only, always starting a stroke. */
const SHAPE = /^M\d{1,4} \d{1,4}(?:[ML]\d{1,4} \d{1,4})*$/;

/**
 * Accepts the path data for a drawn signature, or refuses the whole signing.
 *
 * A single tap produces a lone point with no line after it. That is a smudge
 * rather than a signature, so it is refused here and the guest is asked to
 * sign properly, instead of being recorded as having signed nothing.
 */
export function normaliseSignature(value: unknown): string {
  const refuse = () => {
    throw new BookingError('INVALID_REQUEST', { field: 'signature' }, 'Please sign in the box before submitting.');
  };

  if (typeof value !== 'string') refuse();
  const path = (value as string).trim();
  if (!path || path.length > MAX_LENGTH || !SHAPE.test(path) || !path.includes('L')) refuse();
  return path;
}

/**
 * Guest waiver.
 *
 * The clauses below are Alchemy's own published conditions of use, taken from
 * alchemysaunas.com.au. The binding document is the Terms of Use on the
 * website, which the guest is shown and agrees to by name: this page does not
 * restate it or attempt to improve on it. That keeps one authoritative source
 * of legal wording rather than a second copy that can silently drift.
 *
 * The text is a configuration value (`waiver_text`), editable from the admin
 * screen without a deploy. What is here is only the fallback when nothing has
 * been configured. Bump WAIVER_VERSION whenever the wording changes: the
 * version is stamped on every signature, so which text a guest agreed to stays
 * provable afterwards.
 */

export interface WaiverClause {
  heading: string;
  body: string;
}

export interface WaiverText {
  version: string;
  title: string;
  intro: string;
  /** The authoritative document. Shown as a link and named in the declaration. */
  termsUrl: string;
  termsLabel: string;
  clauses: WaiverClause[];
  declaration: string;
}

export const WAIVER_VERSION = 'ALCHEMY-TOU-2026-09';

export const DEFAULT_WAIVER_TEXT: WaiverText = {
  version: WAIVER_VERSION,
  title: 'Guest acknowledgement and conditions of use',
  intro:
    'You are booked in as a guest at Alchemy. Before you visit, please confirm you have read the Terms of Use and agree to the conditions below. It takes about a minute.',
  termsUrl: 'https://alchemysaunas.com.au/terms-of-use',
  termsLabel: 'Alchemy Saunas Terms of Use',
  clauses: [
    {
      heading: 'You are 18 or over',
      body: 'You must be 18 years of age or older to access and use the facilities.',
    },
    {
      heading: 'Health and wellbeing',
      body:
        'You confirm you have no condition that makes heat or cold exposure unsafe for you, and that you will stop, leave the sauna or ice bath, and tell a staff member if you feel unwell at any point during your visit.',
    },
    {
      heading: 'Before you use the facilities',
      body:
        'Shower before using the ice baths or sauna, and rinse off any sand and salt water before entering the sauna.',
    },
    {
      heading: 'What to bring',
      body: 'Bring a towel and a water bottle each time you attend, and sit on your towel while using the sauna.',
    },
    {
      heading: 'Using the sauna safely',
      body:
        'Wait until your session time begins before entering, limit each sauna use to 15 minutes, and stay hydrated throughout your visit.',
    },
    {
      heading: 'Conduct',
      body:
        'Be kind and respectful to everyone in the space. Do not smoke, consume alcohol or drugs, use offensive language, or behave aggressively. Staff directions must be followed at all times.',
    },
    {
      heading: 'Your details',
      body:
        'Your name and email were given by the member who booked you in, and are held so we can send you this waiver and identify you at the door. Your signature and the time you signed are kept as a record of this acknowledgement.',
    },
  ],
  declaration:
    'By typing my name below I confirm I am 18 or over, that I have read and agree to the Alchemy Saunas Terms of Use and the conditions above, and that the health statement above is true for me.',
};

/**
 * True while the waiver is still unreviewed placeholder wording. Kept as a
 * check rather than deleted, so the health endpoint can still refuse to call
 * the channel ready if someone reverts to a placeholder.
 */
export const IS_PLACEHOLDER = WAIVER_VERSION.startsWith('PLACEHOLDER');

/** Back-compat export for callers that only need the fallback text. */
export const WAIVER_TEXT = DEFAULT_WAIVER_TEXT;

/**
 * Guest waiver text.
 *
 * PLACEHOLDER. This is deliberately not real legal wording.
 *
 * PRD dependency 9.4 puts the waiver wording with Alex Beagley (Minter Ellison)
 * via James, along with confirmation that an emailed signature satisfies
 * Alchemy's insurer. Drafting it here is explicitly out of scope for the build,
 * and shipping invented wording as a liability document would be worse than
 * shipping none.
 *
 * To go live: replace WAIVER_TEXT with the supplied wording and bump
 * WAIVER_VERSION. The version is stamped on every signature record, so which
 * text a guest agreed to stays provable after the wording changes.
 */

export const WAIVER_VERSION = 'PLACEHOLDER-0';

export const IS_PLACEHOLDER = WAIVER_VERSION.startsWith('PLACEHOLDER');

export const WAIVER_TEXT = {
  version: WAIVER_VERSION,
  title: 'Guest waiver and acknowledgement of risk',
  placeholder: IS_PLACEHOLDER,
  intro:
    'This wording is a placeholder pending the final text from Alchemy\'s lawyers. It is shown so the flow can be tested end to end and must be replaced before the channel is opened to members.',
  clauses: [
    {
      heading: 'Health and fitness',
      body: 'Placeholder: guest confirms they have no condition that makes heat or cold exposure unsafe, and that they will stop and seek help if they feel unwell.',
    },
    {
      heading: 'Acknowledgement of risk',
      body: 'Placeholder: guest acknowledges the inherent risks of sauna and cold water immersion.',
    },
    {
      heading: 'Rules of use',
      body: 'Placeholder: guest agrees to follow venue rules and staff directions at all times.',
    },
    {
      heading: 'Personal information',
      body: 'Placeholder: how Alchemy handles the name, email and signature record collected here, and how long it is kept.',
    },
  ],
  declaration:
    'Placeholder: by typing my name below I confirm I have read and agree to the above.',
} as const;

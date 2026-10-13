import { lapsesOn } from './mutes';

/** Per tenant switches; a mute lapses by itself on its date. */
export const mutes = {
  'b.sharingMuted': lapsesOn('2026-11-06'),
};

/** Match the complete trailing disc-player label, never a fragment or following model evidence. */
export const DISC_PLAYER_TYPE_SUFFIX =
  /(?:^|\s+)(?:(?:super\s+audio\s+)?(?:sacd|cd)(?:\s*\/\s*cd)?\s+player|sacd(?:\s*\/\s*cd)?)\s*$/iu;

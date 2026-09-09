const RANK_ORDER = [
  'Iron 1', 'Iron 2', 'Iron 3',
  'Bronze 1', 'Bronze 2', 'Bronze 3',
  'Silver 1', 'Silver 2', 'Silver 3',
  'Gold 1', 'Gold 2', 'Gold 3',
  'Platinum 1', 'Platinum 2', 'Platinum 3',
  'Diamond 1', 'Diamond 2', 'Diamond 3',
  'Ascendant 1', 'Ascendant 2', 'Ascendant 3',
  'Immortal 1', 'Immortal 2', 'Immortal 3',
  'Radiant',
];

/** Convert a rank name like "Gold 2" into a 1-25 numeric score. Unranked -> 0. */
export function tierToScore(tierName) {
  if (!tierName) return 0;
  const idx = RANK_ORDER.findIndex((r) => r.toLowerCase() === tierName.toLowerCase());
  return idx === -1 ? 0 : idx + 1;
}

/**
 * Personal-skill weighted score for team balancing.
 * Uses ACS and KDA as primary individual-skill signals.
 * With tier data: ACS 40%, KDA 50%, current/peak tier 10%.
 * Without tier data: ACS 50%, KDA 50%.
 */
export function computePowerScore({
  kda,
  acs,
  currentTier,
  peakTier,
}) {
  const currentTierScore = tierToScore(currentTier);
  const peakTierScore = tierToScore(peakTier);
  const hasTierScore = currentTierScore > 0 || peakTierScore > 0;
  const tierScore = currentTierScore * 0.7 + peakTierScore * 0.3;

  if (!hasTierScore) {
    return (acs ?? 0) * 0.5 + (kda ?? 0) * 50;
  }

  return (
    (acs ?? 0) * 0.4 +
    (kda ?? 0) * 50 +
    tierScore
  );
}

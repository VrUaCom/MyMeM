/**
 * Decay + reinforcement, ported from OpenMemory's (CaviraOSS) published
 * approach (see MYMEM research Wave 4): a memory's effective weight fades
 * over time unless reinforced, but is never deleted -- decay only affects
 * ranking, not retention. Tiered lambda rates so high-salience memories
 * fade slower than low-salience ones.
 */

export type DecayTier = "hot" | "warm" | "cold";

const LAMBDA_PER_DAY: Record<DecayTier, number> = {
  hot: 0.005,
  warm: 0.02,
  cold: 0.05,
};

export function tierFor(salience: number): DecayTier {
  if (salience >= 0.7) return "hot";
  if (salience >= 0.3) return "warm";
  return "cold";
}

/** decay_factor = exp(-lambda * daysSinceAccess / (salience + 0.1)) */
export function decayFactor(salience: number, daysSinceAccess: number): number {
  const lambda = LAMBDA_PER_DAY[tierFor(salience)];
  const safeDays = Math.max(0, daysSinceAccess);
  return Math.exp((-lambda * safeDays) / (salience + 0.1));
}

export function currentWeight(salience: number, lastAccessedAt: string, now: number = Date.now()): number {
  const daysSinceAccess = (now - Date.parse(lastAccessedAt)) / 86_400_000;
  return salience * decayFactor(salience, daysSinceAccess);
}

/** Reinforcement raises salience but never above 1; never below what it already was. */
export function reinforce(salience: number, boost = 0.2): number {
  return Math.min(1, salience + boost);
}

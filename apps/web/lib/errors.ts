/**
 * The message to show for something thrown.
 *
 * A caught value is `unknown` and genuinely might not be an Error — a rejected
 * promise can carry anything. Every place that reports a failure needs the same
 * two-line dance, so it lives here rather than in each of them.
 */
export function messageFor(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * Produces a trailing moving average while preserving one output point per input point.
 * The leading edge uses the samples available so charts can render immediately.
 */
export function rollingAverage(values: number[], sampleCount: number): number[] {
  const windowSize = Number.isFinite(sampleCount) ? Math.max(1, Math.floor(sampleCount)) : 1;
  const window: Array<number | null> = [];
  let sum = 0;
  let finiteCount = 0;

  return values.map((value) => {
    const finiteValue = Number.isFinite(value) ? value : null;
    window.push(finiteValue);
    if (finiteValue !== null) {
      sum += finiteValue;
      finiteCount += 1;
    }

    if (window.length > windowSize) {
      const removed = window.shift();
      if (removed !== null && removed !== undefined) {
        sum -= removed;
        finiteCount -= 1;
      }
    }

    return finiteCount > 0 ? sum / finiteCount : 0;
  });
}

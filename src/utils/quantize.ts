/**
 * Quantize a value to the nearest valid step size (exchange precision).
 * Example: stepSize = 0.00000001 → 8 decimals; stepSize = 1 → integer
 */
export function quantizeToStepSize(value: number, stepSize: number): number {
  if (!isFinite(value) || !isFinite(stepSize) || stepSize <= 0) return 0;
  const precision = Math.max(0, (stepSize.toString().split('.')[1] || '').length);
  // Floor to nearest step
  const floored = Math.floor(value / stepSize) * stepSize;
  // Fix floating point rounding
  return Number(floored.toFixed(precision));
}

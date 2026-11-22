export function formatAmount(amount: string): string {
  const value = Number(amount);
  return Number.isFinite(value)
    ? value.toLocaleString(undefined, { maximumFractionDigits: 7 })
    : amount;
}

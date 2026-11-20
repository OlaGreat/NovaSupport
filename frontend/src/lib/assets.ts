export type AssetAmount = {
  assetCode: string;
  amount: number;
};

// Pick the asset a creator has earned the most in, so aggregate totals are
// labelled with a real asset code instead of a hardcoded "XLM" (#820, #1285).
export function getDominantAssetCode(
  entries: AssetAmount[],
  fallback = "XLM",
): string {
  return entries.reduce<AssetAmount | null>(
    (dominant, entry) =>
      dominant === null || entry.amount > dominant.amount ? entry : dominant,
    null,
  )?.assetCode ?? fallback;
}

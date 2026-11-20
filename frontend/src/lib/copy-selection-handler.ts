/**
 * Smart copy handler for wallet addresses.
 * Only intercepts Ctrl+C when no text is selected, allowing native copy of selections.
 */

export function handleWalletAddressCopy(address: string) {
  return (e: React.KeyboardEvent<HTMLElement>) => {
    // Check if user has made a text selection
    const selection = window.getSelection();
    const hasSelection = selection && selection.toString().length > 0;

    // Only intercept copy when NO text is selected
    if ((e.ctrlKey || e.metaKey) && e.key === "c" && !hasSelection) {
      e.preventDefault();

      navigator.clipboard.writeText(address).catch((err) => {
        console.error("Failed to copy address:", err);
      });
    }
    // If text is selected, let browser handle native copy
  };
}

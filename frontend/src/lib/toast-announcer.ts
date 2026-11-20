/**
 * Toast announcement utility for accessibility.
 * Uses ARIA live regions for screen reader announcements.
 */

let liveRegion: HTMLElement | null = null;

function getOrCreateLiveRegion(): HTMLElement {
  if (liveRegion) return liveRegion;

  const region = document.createElement("div");
  region.id = "copy-announcement-region";
  region.setAttribute("role", "status");
  region.setAttribute("aria-live", "polite");
  region.setAttribute("aria-atomic", "true");
  region.style.position = "absolute";
  region.style.left = "-10000px";
  region.style.width = "1px";
  region.style.height = "1px";
  region.style.overflow = "hidden";
  document.body.appendChild(region);

  liveRegion = region;
  return region;
}

export function announceCopy(message: string = "Copied to clipboard"): void {
  try {
    const region = getOrCreateLiveRegion();
    region.textContent = message;
  } catch (err) {
    console.log("[a11y announcement]", message);
  }
}

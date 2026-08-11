/**
 * Minimal, privacy-preserving usage counts.
 *
 * DELIBERATE CONSTRAINTS — do not relax these without thinking hard:
 *
 * - **Never send a location.** Not the typed address, not the coordinates, not the
 *   place name. That is someone's home, and correlating it with a session is a real
 *   privacy harm for no analytical benefit. Only the *shape* of what happened is
 *   reported: which verdict appeared, whether building data loaded, and so on.
 * - **No autocapture.** It would hoover up the contents of the address box.
 * - **No cookies and no persistent identifier**, so there is nothing to consent to
 *   under PECR and no banner is needed — which is itself a better experience.
 *
 * Disabled unless a key is configured at build time, so the site works identically
 * with no analytics at all.
 */

const KEY = import.meta.env.VITE_POSTHOG_KEY as string | undefined;
const HOST = (import.meta.env.VITE_POSTHOG_HOST as string | undefined) ?? 'https://eu.i.posthog.com';

/** Events we are willing to record. A closed set, so nothing leaks by accident. */
export type Event =
  | 'verdict_shown'
  | 'address_searched'
  | 'geolocation_used'
  | 'map_clicked'
  | 'near_field_set'
  | 'visibility_scan'
  | 'video_saved'
  | 'link_shared';

type Props = Record<string, string | number | boolean>;

let sessionId = '';

function ensureSession(): string {
  // Per page-load only, held in memory. Never stored, so it cannot follow anyone
  // between visits.
  if (!sessionId) sessionId = Math.random().toString(36).slice(2) + Date.now().toString(36);
  return sessionId;
}

export function track(event: Event, props: Props = {}): void {
  if (!KEY) return;

  const body = JSON.stringify({
    api_key: KEY,
    event,
    properties: {
      ...props,
      distinct_id: ensureSession(),
      $process_person_profile: false,
    },
    timestamp: new Date().toISOString(),
  });

  try {
    // sendBeacon survives the page being closed and never blocks rendering.
    if (navigator.sendBeacon) {
      navigator.sendBeacon(`${HOST}/i/v0/e/`, new Blob([body], { type: 'application/json' }));
      return;
    }
    void fetch(`${HOST}/i/v0/e/`, {
      method: 'POST',
      body,
      headers: { 'Content-Type': 'application/json' },
      keepalive: true,
    });
  } catch {
    // Analytics must never break the page.
  }
}

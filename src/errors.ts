/**
 * Last-resort error handling.
 *
 * Everything here runs in the browser with no server to fall back on, so an
 * uncaught exception previously left a blank dark page with no explanation. That
 * is the worst outcome for someone standing outside on the evening trying to work
 * out where to look.
 */

const BANNER_ID = 'fatal-error';

function showBanner(message: string): void {
  if (document.getElementById(BANNER_ID)) return;

  const el = document.createElement('div');
  el.id = BANNER_ID;
  el.setAttribute('role', 'alert');
  el.innerHTML = `
    <strong>Something went wrong.</strong>
    The eclipse is still on — this page just failed to work out your view.
    <button type="button" id="fatal-reload">Reload</button>
    <span class="detail">${message}</span>
  `;
  document.body.prepend(el);
  document
    .getElementById('fatal-reload')
    ?.addEventListener('click', () => location.reload());
}

/**
 * A page that renders nothing is indistinguishable from a broken network, so
 * surface failures rather than failing silently. Network hiccups in the data
 * layers are handled where they happen; this only catches what escapes.
 */
export function installErrorHandlers(): void {
  window.addEventListener('error', (e) => {
    // Ignore resource load failures (a missing tile is handled elsewhere and is
    // not fatal); only script errors mean the app itself is broken.
    if (e.error) showBanner(String(e.message ?? e.error));
  });

  window.addEventListener('unhandledrejection', (e) => {
    const reason = (e as PromiseRejectionEvent).reason;
    showBanner(String(reason?.message ?? reason ?? 'Unknown error'));
  });
}

/**
 * Live status line: how long until the eclipse, or what is happening right now.
 *
 * On the day this is the difference between a reference page and something people
 * keep open — "starts in 3h 12m" and then "happening now, 43% covered, look west".
 */

import { compassPoint, formatTime, type Circumstances, type Frame } from './eclipse';

export type Phase = 'before' | 'during' | 'after';

export interface Status {
  phase: Phase;
  /** Short line for the header. */
  headline: string;
  /** Supporting detail, may be empty. */
  detail: string;
  /** How long until this line would change meaningfully, in ms. */
  refreshMs: number;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/** "3 hours 12 minutes", "12 minutes", "40 seconds" — never "0 hours 0 minutes". */
function humanGap(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (days > 0) return hours ? `${plural(days, 'day')} ${plural(hours, 'hour')}` : plural(days, 'day');
  if (hours > 0) return minutes ? `${plural(hours, 'hour')} ${plural(minutes, 'minute')}` : plural(hours, 'hour');
  if (minutes > 0) return plural(minutes, 'minute');
  return plural(seconds, 'second');
}

/**
 * Current status for a location.
 *
 * `frames` is the timeline already computed for the report, so the "covered right
 * now" figure comes from the same source as everything else rather than a second,
 * subtly different calculation.
 */
export function statusAt(now: Date, circ: Circumstances, frames: Frame[]): Status {
  const begin = (circ.partialBegin ?? circ.peak).time;
  const end = (circ.partialEnd ?? circ.peak).time;
  const t = now.getTime();

  if (t < begin.getTime()) {
    const gap = begin.getTime() - t;
    return {
      phase: 'before',
      headline: `Starts in ${humanGap(gap)}`,
      detail: `First bite out of the Sun at ${formatTime(begin)}, maximum at ${formatTime(circ.peak.time)}.`,
      // Tick every second in the last few minutes, otherwise every half minute.
      refreshMs: gap < 5 * 60_000 ? 1000 : 30_000,
    };
  }

  if (t <= end.getTime()) {
    // Nearest computed frame, so the live figure matches the scrubber exactly.
    let nearest = frames[0];
    let bestDelta = Infinity;
    for (const f of frames) {
      const d = Math.abs(f.time.getTime() - t);
      if (d < bestDelta) {
        bestDelta = d;
        nearest = f;
      }
    }
    const pct = Math.round((nearest?.obscuration ?? 0) * 100);
    const dir = nearest ? `${compassPoint(nearest.sun.azimuth)}` : '';
    const past = t > circ.peak.time.getTime();

    return {
      phase: 'during',
      headline: `Happening now — ${pct}% covered`,
      detail: past
        ? `Past maximum; it finishes at ${formatTime(end)}. Look ${dir} — and only through eclipse glasses.`
        : `Deepest at ${formatTime(circ.peak.time)}. Look ${dir} — and only through eclipse glasses.`,
      refreshMs: 1000,
    };
  }

  return {
    phase: 'after',
    headline: 'It’s over',
    // Verified with astronomy-engine from London, not from memory: the next
    // partial visible here is 2 Aug 2027, and it is far better placed than this
    // one — 42% covered with the Sun 40 degrees up rather than scraping 10.
    detail: `The eclipse finished at ${formatTime(end)}. The next one visible from the UK is on
      2 August 2027 — about 42% covered, and much higher in the sky.`,
    // Nothing further will change; check rarely in case the tab is left open.
    refreshMs: 60_000,
  };
}

/**
 * Drive a callback on the cadence it asks for: `tick` returns the delay until it
 * wants to run again, so the countdown can be lazy when the eclipse is days away
 * and switch to once a second as it approaches. Returns a stop function.
 */
export function startTicker(tick: () => number): () => void {
  let timer = 0;
  let stopped = false;

  const run = () => {
    const delay = tick();
    if (stopped) return;
    timer = window.setTimeout(run, Math.max(250, delay));
  };

  run();
  return () => {
    stopped = true;
    window.clearTimeout(timer);
  };
}

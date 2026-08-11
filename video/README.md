# Launch video

A [Remotion](https://remotion.dev) composition for the eclipse-planner launch clip.

```bash
cd video
npm install
npm run studio    # preview and scrub
npm run render    # -> out/eclipse-launch.mp4
```

Two compositions are registered: `EclipseLaunch` (1080×1080, for social feeds) and
`EclipseLaunchWide` (1920×1080).

## The crescent is real

`src/geometry.ts` computes the Sun and Moon positions with the same
`astronomy-engine` ephemerides the site uses, sampled from Alexandra Palace. The
animation is the actual 12 August 2026 eclipse, not a hand-drawn approximation —
including the `cos(altitude)` correction that turns an azimuth difference into a
true sky angle, without which the crescent comes out visibly stretched.

## Licence note

The rest of this repository is MIT, but **Remotion is not**. It is free for
individuals and for companies with fewer than four employees; larger companies need
a paid company licence. See <https://remotion.dev/license>. That applies to this
`video/` directory only — nothing in the site itself depends on it.

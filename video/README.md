# Launch video

A [Remotion](https://remotion.dev) composition for the eclipse-planner launch clip.

```bash
cd video
npm install
npm run studio    # preview and scrub
npm run render    # -> out/eclipse-launch.mp4
```

Three compositions are registered: `EclipseLaunch` (1080×1080, for social feeds),
`EclipseLaunchWide` (1920×1080), and `Poster` — a single frame used as the video
thumbnail.

```bash
npm run poster    # -> out/poster.png
```

The poster is composed rather than grabbed from the film: no single frame carries
both the recognisable eclipse and the question, and a muted autoplaying feed needs
both. It uses a 42%-covered crescent, because the actual 91% maximum just reads as
a dark circle at thumbnail size.

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

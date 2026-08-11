import React from 'react';
import { AbsoluteFill } from 'remotion';

import { geometryAtProgress } from './geometry';

const INK = '#e8ecf6';
const DIM = '#98a3bd';
const ACCENT = '#ffb84d';
const BG = '#0b0e16';

const FONT =
  'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", sans-serif';

/**
 * Poster frame for the video thumbnail.
 *
 * No single frame of the film works as a thumbnail: the title card has the
 * question but a small Sun, and the dramatic crescents have no context. In a
 * muted, fast-scrolling feed the still has to carry both — a big recognisable
 * eclipse AND the question — so it is composed rather than grabbed.
 *
 * Progress 0.42 rather than maximum: a fat crescent reads as an eclipse at
 * thumbnail size, where the near-total 91% shape just looks like a dark circle.
 */
export const Poster: React.FC = () => {
  const progress = 0.42;
  const g = geometryAtProgress(progress);

  const size = 500;
  const scale = size / (g.sunRadius * 2.9);
  const sunR = g.sunRadius * scale;
  const cx = size / 2;
  const cy = size / 2;

  return (
    <AbsoluteFill
      style={{
        backgroundColor: BG,
        fontFamily: FONT,
        alignItems: 'center',
        justifyContent: 'center',
        flexDirection: 'column',
        gap: 18,
      }}
    >
      <AbsoluteFill
        style={{
          background:
            'radial-gradient(circle at 50% 33%, rgba(255,184,77,0.16) 0%, rgba(255,150,60,0.04) 40%, rgba(0,0,0,0) 68%)',
        }}
      />

      <svg width={size} height={size} style={{ overflow: 'visible', marginTop: 10 }}>
        <defs>
          <radialGradient id="pSun">
            <stop offset="0%" stopColor="#fff6dc" />
            <stop offset="62%" stopColor="#ffc266" />
            <stop offset="100%" stopColor="#f0973a" />
          </radialGradient>
          <radialGradient id="pGlow">
            <stop offset="0%" stopColor="rgba(255,184,77,0.5)" />
            <stop offset="55%" stopColor="rgba(255,150,60,0.12)" />
            <stop offset="100%" stopColor="rgba(255,150,60,0)" />
          </radialGradient>
        </defs>
        <circle cx={cx} cy={cy} r={sunR * 2.5} fill="url(#pGlow)" />
        <circle cx={cx} cy={cy} r={sunR} fill="url(#pSun)" />
        <circle
          cx={cx + g.dx * scale}
          cy={cy - g.dy * scale}
          r={g.moonRadius * scale}
          fill={BG}
        />
      </svg>

      <div style={{ textAlign: 'center', marginTop: 4 }}>
        <div
          style={{
            fontSize: 96,
            fontWeight: 700,
            letterSpacing: '-0.04em',
            color: INK,
            lineHeight: 1.05,
          }}
        >
          Will I see
          <br />
          the eclipse?
        </div>
        <div style={{ fontSize: 36, color: ACCENT, marginTop: 22, fontWeight: 600 }}>
          Wednesday 12 August 2026 · UK
        </div>
        <div style={{ fontSize: 27, color: DIM, marginTop: 16 }}>
          Check your exact spot — hills, buildings and all
        </div>
      </div>
    </AbsoluteFill>
  );
};

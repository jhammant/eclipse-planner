import React from 'react';
import {
  AbsoluteFill,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
  Sequence,
} from 'remotion';

import { geometryAtProgress } from './geometry';

const INK = '#e8ecf6';
const DIM = '#98a3bd';
const ACCENT = '#ffb84d';
const GOOD = '#4ade80';
const BAD = '#f87171';
const BG = '#0b0e16';

const FONT =
  'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", sans-serif';

/** Scene boundaries in seconds, at 30fps. */
export const SCENES = {
  title: [0, 4],
  problem: [4, 9.5],
  crescent: [9.5, 16],
  verdict: [16, 21.5],
  map: [21.5, 26.5],
  outro: [26.5, 31],
} as const;

export const TOTAL_SECONDS = 31;

/**
 * Fade a scene in and out using its own local timeline.
 *
 * `useCurrentFrame()` inside a <Sequence> is already rebased to the sequence
 * start, so scenes must never subtract their own start time again.
 */
function useFade(durationSec: number, hold = 0.45) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const end = durationSec * fps;
  const inN = interpolate(frame, [0, hold * fps], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const outN = interpolate(frame, [end - hold * fps, end], [1, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  return Math.min(inN, outN);
}

const dur = (k: keyof typeof SCENES) => SCENES[k][1] - SCENES[k][0];

/** The Sun and Moon at a given point through the eclipse, to true geometry. */
const Crescent: React.FC<{ progress: number; size: number; showGlow?: boolean }> = ({
  progress,
  size,
  showGlow = true,
}) => {
  const g = geometryAtProgress(progress);
  // One scale factor for radii and offsets alike, so the shape stays faithful.
  const scale = size / (g.sunRadius * 2.9);
  const sunR = g.sunRadius * scale;
  const moonR = g.moonRadius * scale;
  const cx = size / 2;
  const cy = size / 2;

  return (
    <svg width={size} height={size} style={{ overflow: 'visible' }}>
      <defs>
        <radialGradient id="sunFill">
          <stop offset="0%" stopColor="#fff6dc" />
          <stop offset="62%" stopColor="#ffc266" />
          <stop offset="100%" stopColor="#f0973a" />
        </radialGradient>
        <radialGradient id="glow">
          <stop offset="0%" stopColor="rgba(255,184,77,0.42)" />
          <stop offset="55%" stopColor="rgba(255,150,60,0.10)" />
          <stop offset="100%" stopColor="rgba(255,150,60,0)" />
        </radialGradient>
      </defs>
      {showGlow && (
        <circle cx={cx} cy={cy} r={sunR * (1.6 + 2.2 * (1 - g.obscuration))} fill="url(#glow)" />
      )}
      <circle cx={cx} cy={cy} r={sunR} fill="url(#sunFill)" />
      {/* Moon: +dx is right, +dy is up, so the y offset is negated for screen space. */}
      <circle cx={cx + g.dx * scale} cy={cy - g.dy * scale} r={moonR} fill={BG} />
    </svg>
  );
};

const Title: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const opacity = useFade(dur('title'));
  const rise = spring({ frame: frame - 6, fps, config: { damping: 200 } });

  return (
    <AbsoluteFill
      style={{
        opacity,
        alignItems: 'center',
        justifyContent: 'center',
        flexDirection: 'column',
        gap: 34,
      }}
    >
      <div style={{ transform: `scale(${0.9 + rise * 0.1})` }}>
        <Crescent progress={0.52} size={330} />
      </div>
      <div style={{ textAlign: 'center', transform: `translateY(${(1 - rise) * 26}px)` }}>
        <div style={{ fontSize: 82, fontWeight: 700, letterSpacing: '-0.035em', color: INK }}>
          Will I see the eclipse?
        </div>
        <div style={{ fontSize: 34, color: ACCENT, marginTop: 14, fontWeight: 500 }}>
          Wednesday 12 August 2026 · UK
        </div>
      </div>
    </AbsoluteFill>
  );
};

/** Why this eclipse is different: the Sun is barely off the horizon. */
const Problem: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const opacity = useFade(dur('problem'));
  const local = frame;
  const grow = interpolate(local, [10, 55], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  const W = 900;
  const H = 380;
  const horizonY = H - 70;
  // 10.5 degrees, drawn to scale against a 40-degree tall frame.
  const sunY = horizonY - (10.5 / 40) * (H - 90);

  return (
    <AbsoluteFill
      style={{ opacity, alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 30 }}
    >
      <div style={{ fontSize: 54, fontWeight: 650, color: INK, textAlign: 'center', maxWidth: 900 }}>
        The Sun will be just 10° up
      </div>

      <svg width={W} height={H}>
        <line x1={0} y1={horizonY} x2={W} y2={horizonY} stroke="#2b3346" strokeWidth={2} />
        {/* Ordinary rooftops are enough to hide a Sun this low. */}
        {[80, 200, 330, 470, 610, 760].map((x, i) => {
          const h = [54, 78, 46, 96, 62, 84][i] * grow;
          return <rect key={x} x={x} y={horizonY - h} width={92} height={h} fill="#141a28" stroke="#2b3346" />;
        })}
        <line
          x1={40}
          y1={horizonY}
          x2={40 + 560 * grow}
          y2={horizonY - (sunY < horizonY ? (horizonY - sunY) * grow : 0)}
          stroke={ACCENT}
          strokeWidth={3}
          strokeDasharray="8 6"
          opacity={0.85}
        />
        <g transform={`translate(${600 - 55}, ${sunY - 55})`} opacity={grow}>
          <Crescent progress={0.52} size={110} />
        </g>
      </svg>

      <div style={{ fontSize: 33, color: DIM, textAlign: 'center', maxWidth: 860, lineHeight: 1.45 }}>
        So a hill, a terrace of houses or one tree decides whether you see it at all.
      </div>
    </AbsoluteFill>
  );
};

/** The eclipse itself, animated through its real progression. */
const CrescentScene: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const opacity = useFade(dur('crescent'));
  const local = frame;
  const span = dur('crescent') * fps;
  const t = interpolate(local, [12, span - 12], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const g = geometryAtProgress(t);

  return (
    <AbsoluteFill
      style={{ opacity, alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 40 }}
    >
      <Crescent progress={t} size={430} />
      <div style={{ textAlign: 'center' }}>
        <div
          style={{
            fontSize: 76,
            fontWeight: 700,
            color: ACCENT,
            fontVariantNumeric: 'tabular-nums',
            letterSpacing: '-0.02em',
          }}
        >
          {Math.round(g.obscuration * 100)}% covered
        </div>
        <div style={{ fontSize: 30, color: DIM, marginTop: 10 }}>
          Real ephemerides — not an illustration
        </div>
      </div>
    </AbsoluteFill>
  );
};

const VerdictCard: React.FC<{
  tone: string;
  headline: string;
  body: string;
  delay: number;
}> = ({ tone, headline, body, delay }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const s = spring({ frame: frame - delay, fps, config: { damping: 200 } });
  return (
    <div
      style={{
        opacity: s,
        transform: `translateY(${(1 - s) * 22}px)`,
        border: `2px solid ${tone}55`,
        background: `${tone}14`,
        borderRadius: 20,
        padding: '30px 34px',
        width: 830,
      }}
    >
      <div style={{ fontSize: 50, fontWeight: 700, color: tone, letterSpacing: '-0.02em' }}>
        {headline}
      </div>
      <div style={{ fontSize: 29, color: DIM, marginTop: 12, lineHeight: 1.4 }}>{body}</div>
    </div>
  );
};

const Verdict: React.FC = () => {
  const opacity = useFade(dur('verdict'));
  return (
    <AbsoluteFill
      style={{ opacity, alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 30 }}
    >
      <div style={{ fontSize: 44, fontWeight: 650, color: INK, marginBottom: 6 }}>
        It gives you a straight answer
      </div>
      <VerdictCard
        tone={GOOD}
        headline="Yes — 91% of the Sun covered"
        body="Clear of your skyline at the deepest point. It won't go dark — expect a strange, flat, dimmed light."
        delay={0}
      />
      <VerdictCard
        tone={BAD}
        headline="No — not from here"
        body="The Sun stays behind a building about 76 m away for the whole eclipse."
        delay={14}
      />
    </AbsoluteFill>
  );
};

/** The visibility grid: sunlight and line of sight are the same question. */
const MapScene: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const opacity = useFade(dur('map'));
  const local = frame;

  const cols = 22;
  const cell = 38;
  const grid = React.useMemo(() => {
    // A deterministic pseudo-terrain so the pattern reads like a landscape
    // rather than noise: ridges blocking, valleys open.
    const out: number[] = [];
    for (let y = 0; y < cols; y++) {
      for (let x = 0; x < cols; x++) {
        const v =
          Math.sin(x * 0.42) * Math.cos(y * 0.36) +
          Math.sin((x + y) * 0.21) * 0.7 +
          Math.cos(x * 0.13 - y * 0.19) * 0.5;
        out.push(v);
      }
    }
    return out;
  }, []);

  return (
    <AbsoluteFill
      style={{ opacity, alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 34 }}
    >
      <div style={{ fontSize: 50, fontWeight: 650, color: INK, textAlign: 'center', maxWidth: 900 }}>
        And a map of where it's visible
      </div>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: `repeat(${cols}, ${cell}px)`,
          gap: 2,
          borderRadius: 12,
          overflow: 'hidden',
        }}
      >
        {grid.map((v, i) => {
          const reveal = interpolate(local, [8 + (i % cols) * 1.1, 30 + (i % cols) * 1.1], [0, 1], {
            extrapolateLeft: 'clamp',
            extrapolateRight: 'clamp',
          });
          const colour = v > 0.55 ? BAD : v > 0.05 ? ACCENT : GOOD;
          return (
            <div
              key={i}
              style={{
                width: cell,
                height: cell,
                background: colour,
                opacity: reveal * 0.55,
              }}
            />
          );
        })}
      </div>
      <div style={{ fontSize: 30, color: DIM, textAlign: 'center' }}>
        Standing in sunlight <em>is</em> having line of sight to the Sun
      </div>
    </AbsoluteFill>
  );
};

const Outro: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const opacity = useFade(dur('outro'), 0.5);
  const s = spring({ frame, fps, config: { damping: 200 } });

  return (
    <AbsoluteFill
      style={{ opacity, alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 28 }}
    >
      <div style={{ transform: `scale(${0.94 + s * 0.06})` }}>
        <Crescent progress={0.52} size={220} />
      </div>
      <div style={{ fontSize: 68, fontWeight: 700, color: ACCENT, letterSpacing: '-0.02em' }}>
        eclipse.hammantlabs.com
      </div>
      <div style={{ fontSize: 30, color: DIM, textAlign: 'center', maxWidth: 800, lineHeight: 1.45 }}>
        Free, no sign-up, runs entirely in your browser.
        <br />
        Open source: github.com/jhammant/eclipse-planner
      </div>
      <div
        style={{
          marginTop: 14,
          fontSize: 25,
          color: '#ffd9a8',
          border: `1px solid ${ACCENT}55`,
          background: 'rgba(255,184,77,0.10)',
          borderRadius: 12,
          padding: '14px 22px',
        }}
      >
        Never look at the Sun without ISO 12312-2 eclipse glasses
      </div>
    </AbsoluteFill>
  );
};

export const EclipseLaunch: React.FC = () => {
  const { fps } = useVideoConfig();
  const sec = (n: number) => Math.round(n * fps);

  return (
    <AbsoluteFill style={{ backgroundColor: BG, fontFamily: FONT }}>
      {/* A single low glow anchors every scene so cuts feel like one film. */}
      <AbsoluteFill
        style={{
          background:
            'radial-gradient(circle at 50% 34%, rgba(255,184,77,0.10) 0%, rgba(255,150,60,0.03) 38%, rgba(0,0,0,0) 66%)',
        }}
      />
      <Sequence from={sec(SCENES.title[0])} durationInFrames={sec(SCENES.title[1] - SCENES.title[0])}>
        <Title />
      </Sequence>
      <Sequence from={sec(SCENES.problem[0])} durationInFrames={sec(SCENES.problem[1] - SCENES.problem[0])}>
        <Problem />
      </Sequence>
      <Sequence from={sec(SCENES.crescent[0])} durationInFrames={sec(SCENES.crescent[1] - SCENES.crescent[0])}>
        <CrescentScene />
      </Sequence>
      <Sequence from={sec(SCENES.verdict[0])} durationInFrames={sec(SCENES.verdict[1] - SCENES.verdict[0])}>
        <Verdict />
      </Sequence>
      <Sequence from={sec(SCENES.map[0])} durationInFrames={sec(SCENES.map[1] - SCENES.map[0])}>
        <MapScene />
      </Sequence>
      <Sequence from={sec(SCENES.outro[0])} durationInFrames={sec(SCENES.outro[1] - SCENES.outro[0])}>
        <Outro />
      </Sequence>
    </AbsoluteFill>
  );
};

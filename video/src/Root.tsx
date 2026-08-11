import React from 'react';
import { Composition } from 'remotion';

import { EclipseLaunch, TOTAL_SECONDS } from './EclipseLaunch';
import { Poster } from './Poster';

const FPS = 30;

export const RemotionRoot: React.FC = () => (
  <>
    {/* Square: LinkedIn's feed gives 1:1 more vertical space than 16:9. */}
    <Composition
      id="EclipseLaunch"
      component={EclipseLaunch}
      durationInFrames={Math.round(TOTAL_SECONDS * FPS)}
      fps={FPS}
      width={1080}
      height={1080}
    />
    <Composition
      id="EclipseLaunchWide"
      component={EclipseLaunch}
      durationInFrames={Math.round(TOTAL_SECONDS * FPS)}
      fps={FPS}
      width={1920}
      height={1080}
    />
    {/* Single-frame poster used as the video thumbnail. */}
    <Composition
      id="Poster"
      component={Poster}
      durationInFrames={1}
      fps={FPS}
      width={1080}
      height={1080}
    />
  </>
);

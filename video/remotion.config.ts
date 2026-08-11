import { Config } from '@remotion/cli/config';

Config.setVideoImageFormat('jpeg');
Config.setOverwriteOutput(true);
// The compositions are flat colour and text; a higher CRF would show banding in
// the Sun's radial gradient.
Config.setCrf(18);

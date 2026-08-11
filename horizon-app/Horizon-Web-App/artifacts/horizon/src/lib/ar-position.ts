import { angularDifference } from './geodesy';

export const DEFAULT_HORIZONTAL_FOV = 70;

export type ArPosition = {
  left: number;
  top: number;
  alignment: number;
};

export function getArPosition(
  bearing: number,
  heading: number,
  pitchDegrees: number | null,
  horizontalFov = DEFAULT_HORIZONTAL_FOV,
): ArPosition {
  const signedDelta = ((bearing - heading + 540) % 360) - 180;
  const left = Math.max(7, Math.min(93, 50 + (signedDelta / horizontalFov) * 50));
  const top = pitchDegrees === null
    ? 50
    : Math.max(28, Math.min(72, 50 - pitchDegrees * 0.22));

  return {
    left,
    top,
    alignment: angularDifference(bearing, heading),
  };
}

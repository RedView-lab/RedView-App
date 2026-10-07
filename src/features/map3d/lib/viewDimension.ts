/** Au-delà de cette inclinaison (°), la carte est en 3D (bouton 2D / 3D). */
const THREE_D_PITCH_THRESHOLD_DEG = 8;

export function isThreeDPitch(pitchDeg: number): boolean {
  return pitchDeg > THREE_D_PITCH_THRESHOLD_DEG;
}

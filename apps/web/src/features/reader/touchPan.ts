type Velocity = {x: number; y: number};

export function horizontalPanOrigin(dx: number, dy: number): number | null {
  const threshold = Math.max(28, Math.min(64, Math.abs(dy) * .42));
  return Math.abs(dx) >= threshold ? Math.sign(dx) * threshold : null;
}

export function touchMomentum(velocity: Velocity, verticalTravel: number, freePan: boolean) {
  const rapid = !freePan && Math.abs(verticalTravel) >= 100 && Math.abs(velocity.y) >= .65
    && verticalTravel * velocity.y < 0;
  const boost = rapid ? Math.min(2, 1.35 + (Math.abs(verticalTravel) - 100) / 300) : 1;
  return {
    x: freePan ? velocity.x : 0,
    y: velocity.y * boost,
    decayTime: rapid ? 215 : 135,
  };
}

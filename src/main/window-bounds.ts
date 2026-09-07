export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** True when saved window bounds are sane and their centre lands on an attached display. */
export function boundsOnSomeDisplay(bounds: Bounds, displays: Bounds[]): boolean {
  if (!(bounds.width >= 200 && bounds.height >= 150)) return false;
  const cx = bounds.x + bounds.width / 2;
  const cy = bounds.y + bounds.height / 2;
  return displays.some((d) => cx >= d.x && cx < d.x + d.width && cy >= d.y && cy < d.y + d.height);
}

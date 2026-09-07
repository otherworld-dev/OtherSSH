import { describe, it, expect } from 'vitest';
import { boundsOnSomeDisplay } from './window-bounds';

const primary = { x: 0, y: 0, width: 1920, height: 1080 };
const second = { x: 1920, y: 0, width: 2560, height: 1440 };

describe('boundsOnSomeDisplay', () => {
  it('accepts bounds whose centre lies on a display', () => {
    const b = { x: 100, y: 100, width: 800, height: 600 };
    expect(boundsOnSomeDisplay(b, [primary, second])).toBe(true);
    expect(boundsOnSomeDisplay({ x: 2500, y: 200, width: 800, height: 600 }, [primary, second])).toBe(true);
  });

  it('rejects bounds from a monitor that is no longer attached', () => {
    expect(boundsOnSomeDisplay({ x: 2500, y: 200, width: 800, height: 600 }, [primary])).toBe(false);
    expect(boundsOnSomeDisplay({ x: -3000, y: 100, width: 800, height: 600 }, [primary])).toBe(false);
  });

  it('rejects nonsense sizes', () => {
    expect(boundsOnSomeDisplay({ x: 0, y: 0, width: 50, height: 600 }, [primary])).toBe(false);
    expect(boundsOnSomeDisplay({ x: 0, y: 0, width: 800, height: 0 }, [primary])).toBe(false);
  });
});

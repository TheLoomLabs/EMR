import { describe, expect, it } from 'vitest';
import { planWindowRect } from './window-geometry';

describe('planWindowRect', () => {
  it('sizes and centres for a small laptop screen, clamped to the minimum height', () => {
    const rect = planWindowRect({ width: 1366, height: 768 });
    expect(rect).toEqual({ left: 205, top: 84, width: 956, height: 600 });
  });

  it('clamps both dimensions to the maximum on a large monitor', () => {
    const rect = planWindowRect({ width: 2560, height: 1440 });
    expect(rect).toEqual({ left: 480, top: 220, width: 1600, height: 1000 });
  });

  it('clamps to the same maximum on an ultrawide, centring differently than the large monitor', () => {
    const rect = planWindowRect({ width: 3440, height: 1440 });
    expect(rect).toEqual({ left: 920, top: 220, width: 1600, height: 1000 });
  });

  it('restores a remembered rectangle verbatim, ignoring the screen entirely', () => {
    const remembered = { left: 100, top: 50, width: 900, height: 700 };
    expect(planWindowRect({ width: 1920, height: 1080 }, remembered)).toEqual(remembered);
    expect(planWindowRect({ width: 100, height: 100 }, remembered)).toEqual(remembered);
  });
});

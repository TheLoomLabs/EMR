// The `clock` port (issue #1's Implementation Decisions → The seam). Lets a Run be driven by
// a fixed instant in a test rather than the real wall clock.

export interface Clock {
  now(): number;
}

export const systemClock: Clock = {
  now: () => Date.now(),
};

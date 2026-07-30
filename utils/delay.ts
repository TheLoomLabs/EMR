// The `delay` port (issue #9): lets a Run wait between Exports without a real timer running
// inside a test. HANDOFF: "Exports fetched sequentially with a small delay... do not
// parallelise — this is a government portal and the extension is headed for public
// distribution." Mirrors utils/clock.ts's shape for the same reason: real time in prod, a
// fake in tests.

export interface Delay {
  wait(ms: number): Promise<void>;
}

export const systemDelay: Delay = {
  wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

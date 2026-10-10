// Onward — injectable clock.
//
// Single source of truth for "now" across the deterministic layer.
// Every service that needs the current time must call now() from here,
// never `new Date()` directly.
//
// Two modes:
//   - REAL (default):    now() returns the actual current time.
//   - SIMULATED:         now() returns a fixed cursor, optionally moved
//                        by advanceBy(n) or advanceByCumulative(n).
//
// Two ways to advance:
//   - advanceBy(n)             → set the cursor to real-now + n days.
//                                Idempotent: calling it twice with the
//                                same n gives the same result. This is
//                                what the demo buttons use.
//   - advanceByCumulative(n)   → add n days to whatever the cursor is now
//                                (or to real-now if unset). Repeated calls
//                                accumulate. Use for scripted walkthroughs.
//
// Nothing in this module touches the database or performs I/O.

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

/** @type {Date | null} null means "use real time". */
let simulatedNow = null;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Return the current time.
 * In REAL mode, this is the actual current time.
 * In SIMULATED mode, this is the cursor.
 *
 * @returns {Date}
 */
export function now() {
  if (simulatedNow === null) {
    return new Date();
  }
  return new Date(simulatedNow.getTime());
}

/**
 * Set the simulated cursor to real-now + N days, or to a specific instant.
 * Enters SIMULATED mode.
 *
 * Accepts:
 *   - a number (interpreted as days from real now)
 *   - a Date
 *   - an ISO string
 *   - a millisecond epoch number
 *
 * @param {number | Date | string} when
 */
export function setNow(when) {
  if (typeof when === 'number' && Number.isFinite(when)) {
    // Number → days from real now.
    const real = new Date();
    simulatedNow = new Date(real.getTime() + when * MS_PER_DAY);
    return;
  }
  const d = toDate(when);
  if (!d) {
    throw new Error(`[onward/clock] setNow: invalid date input: ${when}`);
  }
  simulatedNow = d;
}

/**
 * Set the cursor to real-now + N days. Idempotent — calling twice with the
 * same N gives the same result. This is what "+N days" demo buttons should
 * use: each click means "show me the world N days from today", not "add N
 * to however far we've already moved".
 *
 * @param {number} days
 */
export function advanceBy(days) {
  if (typeof days !== 'number' || !Number.isFinite(days)) {
    throw new Error(`[onward/clock] advanceBy: days must be a finite number, got ${days}`);
  }
  const real = new Date();
  simulatedNow = new Date(real.getTime() + days * MS_PER_DAY);
}

/**
 * Add N days to the current cursor (or to real now if unset). Repeated
 * calls accumulate. Use for scripted walkthroughs like "Day 1 → Day 3 →
 * Day 5".
 *
 * @param {number} days
 */
export function advanceByCumulative(days) {
  if (typeof days !== 'number' || !Number.isFinite(days)) {
    throw new Error(`[onward/clock] advanceByCumulative: days must be a finite number, got ${days}`);
  }
  const base = simulatedNow ?? new Date();
  simulatedNow = new Date(base.getTime() + days * MS_PER_DAY);
}

/**
 * Return to REAL mode. Also call this on server start if you want a fresh
 * process to never inherit a stale simulated cursor — but note the module
 * starts with simulatedNow = null anyway, so a fresh process is already
 * in real mode.
 */
export function resetClock() {
  simulatedNow = null;
}

/**
 * True if the clock is currently in SIMULATED mode.
 * @returns {boolean}
 */
export function isSimulated() {
  return simulatedNow !== null;
}

/**
 * How many days the simulated cursor is offset from real now.
 * Returns 0 in REAL mode.
 *
 * @returns {number}
 */
export function simulatedOffsetDays() {
  if (simulatedNow === null) return 0;
  const real = new Date();
  return (simulatedNow.getTime() - real.getTime()) / MS_PER_DAY;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * Coerce Date | string | number to a Date, or return null if invalid.
 * @param {Date | string | number} input
 * @returns {Date | null}
 */
function toDate(input) {
  if (input instanceof Date) {
    return Number.isNaN(input.getTime()) ? null : new Date(input.getTime());
  }
  if (typeof input === 'string' || typeof input === 'number') {
    const d = new Date(input);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}
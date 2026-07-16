/**
 * public/js/animations.js
 * ---------------------------------------------------------------------------
 * Purpose:
 *   A generic, reusable step-trace player — the animation engine behind the
 *   CYK simulation. It knows NOTHING about CYK: it owns a list of steps and
 *   the play/pause/seek mechanics, while the caller supplies:
 *
 *     applyStep(step, {animate})  render one step onto the DOM
 *     resetView()                 rebuild the empty visualisation
 *     stepDelay(step)             base duration (ms) to linger on a step
 *     onProgress(player)          progress callback (index, playing state)
 *
 *   Seeking backwards is implemented as "reset + fast-forward without
 *   animation": every applyStep must therefore be idempotent-friendly and
 *   cheap when called with {animate: false}. For the trace sizes CFG Studio
 *   produces (≤ ~5 000 steps) this replay strategy is instantaneous and
 *   avoids the complexity of invertible steps.
 */

export class StepPlayer {
  constructor({ steps, applyStep, resetView, stepDelay, onProgress }) {
    this.steps = steps;
    this.applyStep = applyStep;
    this.resetView = resetView;
    this.stepDelay = stepDelay ?? (() => 800);
    this.onProgress = onProgress ?? (() => {});

    this.position = 0; // number of steps already applied
    this.playing = false;
    this.speed = 1;
    this.timer = null;

    this.resetView();
    this.onProgress(this);
  }

  get length() {
    return this.steps.length;
  }

  get done() {
    return this.position >= this.steps.length;
  }

  /** Apply the next step. @returns false when the trace is exhausted. */
  #applyNext(animate) {
    if (this.done) return false;
    const step = this.steps[this.position];
    this.applyStep(step, { animate });
    this.position += 1;
    this.onProgress(this);
    return step;
  }

  #clearTimer() {
    clearTimeout(this.timer);
    this.timer = null;
  }

  #tick() {
    if (!this.playing) return;
    const step = this.#applyNext(true);
    if (!step || this.done) {
      this.pause();
      return;
    }
    this.timer = setTimeout(() => this.#tick(), this.stepDelay(step) / this.speed);
  }

  /** Start (or resume) playback; a finished trace restarts from step 0. */
  play() {
    if (this.playing) return;
    if (this.done) this.seek(0); // replay from the start
    this.playing = true;
    this.onProgress(this);
    this.#tick();
  }

  /** Stop the timer chain; the current position is retained. */
  pause() {
    this.playing = false;
    this.#clearTimer();
    this.onProgress(this);
  }

  /** Play ⇄ pause, for a single toolbar button. */
  toggle() {
    this.playing ? this.pause() : this.play();
  }

  /** Pause and advance exactly one step (with animation). */
  stepForward() {
    this.pause();
    this.#applyNext(true);
  }

  /** Pause and go one step back — implemented as seek(position − 1),
   *  i.e. reset + silent fast-forward; see the class header for why. */
  stepBack() {
    this.pause();
    this.seek(this.position - 1);
  }

  /**
   * Jump to "k steps applied" by resetting and fast-forwarding.
   * All replayed steps run with {animate: false}, so highlight/flash
   * effects are skipped and only the accumulated state is rebuilt.
   *
   * @param {number} k Target position, clamped into [0, steps.length].
   */
  seek(k) {
    this.#clearTimer();
    const target = Math.max(0, Math.min(k, this.steps.length));
    this.resetView();
    this.position = 0;
    while (this.position < target) this.#applyNext(false);
    this.onProgress(this);
  }

  /** Jump straight to the final state (verdict visible immediately). */
  skipToEnd() {
    this.pause();
    this.seek(this.steps.length);
  }

  /**
   * Playback speed multiplier (1 = the caller's stepDelay verbatim).
   * Takes effect from the NEXT scheduled step — the currently pending
   * timeout keeps the delay it was scheduled with.
   *
   * @param {number} speed e.g. 0.5, 1, 2, 4.
   */
  setSpeed(speed) {
    this.speed = speed;
  }

  /** Stop timers before discarding the player (view teardown). */
  destroy() {
    this.playing = false;
    this.#clearTimer();
  }
}

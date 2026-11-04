/**
 * Alarm-driven scheduler.
 *
 * The engine calls `setTimeout`/`clearTimeout`; on Cloudflare there is no
 * always-on process, so pending callbacks are kept in memory and the Durable
 * Object's single alarm is pointed at the earliest one. When the alarm fires,
 * every due callback runs and the next alarm is scheduled.
 */

export class AlarmTimers {
  constructor(ctx) {
    this.ctx = ctx;
    this.tasks = new Map();
    this.nextId = 1;
    this._chain = Promise.resolve();
  }

  setTimeout(fn, ms) {
    const id = this.nextId++;
    this.tasks.set(id, { at: Date.now() + Math.max(0, Number(ms) || 0), fn });
    this._arm();
    return id;
  }

  clearTimeout(id) {
    if (this.tasks.delete(id)) this._arm();
  }

  _earliest() {
    let next = null;
    for (const task of this.tasks.values()) {
      if (next === null || task.at < next) next = task.at;
    }
    return next;
  }

  _arm() {
    const next = this._earliest();
    this._chain = this._chain
      .catch(() => null)
      .then(async () => {
        if (next === null) {
          await this.ctx.storage.deleteAlarm();
          return;
        }
        await this.ctx.storage.setAlarm(Math.max(next, Date.now() + 25));
      });
    return this._chain;
  }

  /** Run callbacks whose deadline has passed, then re-arm for the next one. */
  async runDue() {
    const cutoff = Date.now() + 20;
    const due = [];
    for (const [id, task] of this.tasks) {
      if (task.at <= cutoff) due.push([id, task]);
    }
    due.sort((a, b) => a[1].at - b[1].at);

    for (const [id, task] of due) {
      if (this.tasks.get(id) !== task) continue;
      this.tasks.delete(id);
      try {
        await task.fn();
      } catch (err) {
        console.error("[timers] task failed:", err && err.message);
      }
    }

    await this._arm();
  }
}

/**
 * Durable Object storage adapter for the paper-trading engine.
 *
 * Mirrors the tiny Store API used by `src/engine.js` (`load`, `save`,
 * `replace`, `flush`) but keeps the snapshot in the Durable Object's SQLite
 * storage instead of a JSON file.
 */

import { createInitialState, sanitizeLoadedState } from "../src/store.js";

const FLUSH_DELAY_MS = 400;

export class DurableStore {
  constructor(storage, saved, key = "state") {
    this.storage = storage;
    this.key = key;
    this.state = saved ? sanitizeLoadedState(saved) : null;
    this._timer = null;
    this._dirty = false;
    this._chain = Promise.resolve();
  }

  load() {
    if (!this.state) {
      this.state = createInitialState();
      this.save(this.state);
    }
    return this.state;
  }

  replace(state) {
    this.state = state;
    this.save(state);
  }

  save(state) {
    if (state) this.state = state;
    this._dirty = true;
    if (this._timer) return;
    this._timer = setTimeout(() => {
      this._timer = null;
      this.flush();
    }, FLUSH_DELAY_MS);
  }

  flush() {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    if (!this._dirty) return this._chain;
    this._dirty = false;
    const snapshot = this.state;
    this._chain = this._chain
      .catch(() => null)
      .then(() => this.storage.put(this.key, snapshot));
    return this._chain;
  }
}

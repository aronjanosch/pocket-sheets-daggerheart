/**
 * Pocket Sheets — Daggerheart — adapter registry (Phase 0).
 *
 * The extension point. Built-in adapters self-register on `init`; third-party
 * adapters register via the public module API or the `pocketSheetsDaggerheart.ready` hook
 * (see scripts/main.js). A new system = one adapter file, zero core changes,
 * no load-order coupling.
 *
 * @typedef {import("./contract.js").PocketSheetAdapter} PocketSheetAdapter
 */

/** @type {Map<string, PocketSheetAdapter>} systemId -> adapter */
const adapters = new Map();

/**
 * Register an adapter for its system. Last registration for a given systemId
 * wins, letting a third-party module override a built-in adapter.
 * @param {PocketSheetAdapter} adapter
 */
export function register(adapter) {
  if (!adapter?.systemId) {
    console.error("pocket-sheets-daggerheart | register called without a systemId", adapter);
    return;
  }
  adapters.set(adapter.systemId, adapter);
}

/**
 * Resolve the adapter for a system id, or null if none is registered.
 * @param {string} systemId
 * @returns {PocketSheetAdapter|null}
 */
export function resolve(systemId) {
  return adapters.get(systemId) ?? null;
}

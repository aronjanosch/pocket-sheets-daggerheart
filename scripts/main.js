/**
 * Pocket Sheets — Daggerheart — entry point.
 *
 * Wires the adapter registry, the public extension API, the Handlebars helper /
 * partials, and registers the shell sheet. With no adapter for the active system
 * the sheet still loads and shows a graceful "no-adapter" state — never an error.
 *
 * Load-order safety (spec phase-0 §6): the API is attached to the module record
 * at `init` (so adapters registering from their own `init` find it), and the
 * `pocketSheetsDaggerheart.ready` hook fires at `setup` (after every module's `init`). The
 * shell sheet is registered at `ready`, once all adapters have had both chances
 * to register, so its actor-type restriction reflects the resolved adapter.
 */

import { MODULE_ID } from "./constants.js";
import { register, resolve } from "./registry.js";
import { PocketSheet, registerPocketSheet } from "./sheet.js";
import { registerActivationSettings, activateLauncher, applyMobileCanvasMode } from "./launcher.js";
import { daggerheartAdapter } from "../adapters/daggerheart.js";

export { MODULE_ID };

/**
 * @typedef {object} PocketSheetApi
 * @property {typeof register} register
 * @property {typeof resolve}  resolve
 * @property {typeof PocketSheet} PocketSheet
 */

/** @type {PocketSheetApi} */
const api = { register, resolve, PocketSheet };

Hooks.once("init", () => {
  const module = game.modules.get(MODULE_ID);
  if (module) module.api = api;

  // Pre-register block partials so the template's dynamic `{{> path}}` resolves.
  foundry.applications.handlebars.loadTemplates([
    `modules/${MODULE_ID}/templates/blocks/resource.hbs`,
    `modules/${MODULE_ID}/templates/blocks/itemResource.hbs`,
    `modules/${MODULE_ID}/templates/blocks/statGrid.hbs`,
    `modules/${MODULE_ID}/templates/blocks/tags.hbs`,
    `modules/${MODULE_ID}/templates/blocks/actionList.hbs`,
    `modules/${MODULE_ID}/templates/blocks/info.hbs`,
    `modules/${MODULE_ID}/templates/blocks/heading.hbs`,
    `modules/${MODULE_ID}/templates/blocks/buttons.hbs`,
    `modules/${MODULE_ID}/templates/blocks/scale.hbs`,
    // Mode partials (Chat / Journal) — referenced by path like the block partials above.
    `modules/${MODULE_ID}/templates/chat.hbs`,
    `modules/${MODULE_ID}/templates/journal.hbs`
  ]);

  // Activation layer: when/where to auto-present the sheet (Phase 3).
  registerActivationSettings();

  // Built-in adapters self-register here.
  register(daggerheartAdapter);

  console.log(`${MODULE_ID} | initialized`);
});

Hooks.once("setup", () => {
  // Phone = pure sheet device: kill the map canvas before it draws. Runs here,
  // not at `init` — core registers `core.noCanvas` only after the `init` phase.
  // May reload the page once; the rest of setup is harmless if it does.
  applyMobileCanvasMode();

  // After every module's `init` — third-party adapters listening for this register now.
  Hooks.callAll("pocketSheetsDaggerheart.ready", api);
});

Hooks.once("ready", () => {
  registerPocketSheet();

  // Phase 3: install the launcher and auto-open on mobile.
  activateLauncher();
});

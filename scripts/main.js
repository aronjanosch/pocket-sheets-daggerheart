/**
 * Pocket Sheet — entry point.
 *
 * Wires the adapter registry, the public extension API, the Handlebars helper /
 * partials, and registers the shell sheet. With no adapter for the active system
 * the sheet still loads and shows a graceful "no-adapter" state — never an error.
 *
 * Load-order safety (spec phase-0 §6): the API is attached to the module record
 * at `init` (so adapters registering from their own `init` find it), and the
 * `pocketSheet.ready` hook fires at `setup` (after every module's `init`). The
 * shell sheet is registered at `ready`, once all adapters have had both chances
 * to register, so its actor-type restriction reflects the resolved adapter.
 */

import { MODULE_ID } from "./constants.js";
import { register, resolve } from "./registry.js";
import { PocketSheet, registerPocketSheet } from "./sheet.js";
import { registerActivationSettings, activateLauncher } from "./launcher.js";
import { stubAdapter } from "./stub-adapter.js";
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
    `modules/${MODULE_ID}/templates/blocks/statGrid.hbs`,
    `modules/${MODULE_ID}/templates/blocks/tags.hbs`,
    `modules/${MODULE_ID}/templates/blocks/actionList.hbs`,
    `modules/${MODULE_ID}/templates/blocks/info.hbs`,
    `modules/${MODULE_ID}/templates/blocks/heading.hbs`,
    `modules/${MODULE_ID}/templates/blocks/buttons.hbs`
  ]);

  // Dev-only: a flag to register the stub adapter for shell testing (Phase 1 §8).
  game.settings.register(MODULE_ID, "devStub", {
    name: "MOBILE_SHEET.settings.devStub.name",
    hint: "MOBILE_SHEET.settings.devStub.hint",
    scope: "client",
    config: true,
    type: Boolean,
    default: false
  });

  // Activation layer: when/where to auto-present the sheet (Phase 3).
  registerActivationSettings();

  // Built-in adapters self-register here.
  register(daggerheartAdapter);

  console.log(`${MODULE_ID} | initialized`);
});

Hooks.once("setup", () => {
  // After every module's `init` — third-party adapters listening for this register now.
  Hooks.callAll("pocketSheet.ready", api);
});

Hooks.once("ready", () => {
  // Dev stub: register last (overrides) and bind to the active system so resolve finds it.
  if (game.settings.get(MODULE_ID, "devStub")) {
    stubAdapter.systemId = game.system.id;
    register(stubAdapter);
    console.warn(`${MODULE_ID} | dev stub adapter active for system "${game.system.id}"`);
  }

  registerPocketSheet();

  // Phase 3: install the launcher and auto-open on mobile.
  activateLauncher();
});

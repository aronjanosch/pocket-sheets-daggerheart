/**
 * Pocket Sheets — Daggerheart — activation layer (Phase 3). See specs/phase-3-activation.md.
 *
 * Decides WHEN to present the mobile sheet and FOR WHICH actor — never what it
 * renders (that is the adapter). Purely client-side presentation: reads no
 * `actor.system`, touches no world data, adds no sync.
 *
 * The crux decision: we open the shell EXPLICITLY (`new PocketSheet(...).render`)
 * instead of changing Foundry's default sheet class. Foundry stores the default
 * sheet per-world / per-actor — never per-client — so flipping it for a mobile
 * player would also change it for the DM on the desktop. Explicit render keeps
 * the desktop experience byte-for-byte vanilla.
 */

import { MODULE_ID, isPhone, isTablet, isPocketDevice } from "./constants.js";
import { resolve } from "./registry.js";
import { PocketSheet } from "./sheet.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

// --- mobile detection + activation setting ---------------------------------
// Detection itself lives in constants.js (so sheet.js can share it without an import
// cycle); the launcher only decides what to DO with it.

function activationMode() {
  return game.settings.get(MODULE_ID, "activation");
}

/** Is pocket mode active on THIS device? The single on/off behind auto-open, the
 *  launcher button, and the canvas-kill. `never` = full desktop Foundry even on an
 *  iPad (the escape hatch for an iPad user who wants to play with the map). */
function pocketModeActive() {
  const mode = activationMode();
  if (mode === "never") return false;
  if (mode === "always") return true;
  return isPocketDevice();            // "auto"
}

/** Should the sheet auto-open on `ready`? */
function shouldActivate() {
  return pocketModeActive();
}

/** Should the persistent launcher button exist? Whenever pocket mode is active —
 *  on `never` there's no button, so the device behaves like vanilla Foundry. */
function shouldShowFab() {
  return pocketModeActive();
}

/** Turn pocket mode ON for THIS device and reload (canvas state only applies after a
 *  reload). On a phone/tablet we restore `auto` (the clean default, re-detected); on a
 *  desktop we force `always`, since `auto` would resolve to off there. The inverse FAB
 *  and the supplied macro both call this. */
export async function enterPocketMode() {
  await game.settings.set(MODULE_ID, "activation", isPocketDevice() ? "auto" : "always");
  location.reload();
}

/** Turn pocket mode OFF for THIS device (full Foundry interface, map on) and reload.
 *  Called by the in-sheet exit button and by `api.exitPocketMode()`. */
export async function exitPocketMode() {
  await game.settings.set(MODULE_ID, "activation", "never");
  location.reload();
}

/** Seed the "Toggle Pocket Mode" macro into the module's compendium (GM only, once).
 *  We ship no pre-packed LevelDB — packing one is a build step this module forbids — so
 *  the `packs` entry in module.json makes Foundry auto-create an empty pack and we fill it
 *  here. Idempotent: the pack index is the source of truth, so a deleted macro stays gone
 *  only until the pack is empty again; an existing one is never duplicated. */
async function seedToggleMacro() {
  if (!game.user.isGM) return;

  const pack = game.packs?.get(`${MODULE_ID}.macros`);
  if (!pack) return; // pack not declared / not ready

  try {
    const index = await pack.getIndex();
    if (index.some((e) => e.name === "Toggle Pocket Mode")) return; // already seeded

    const command =
      `const id = "${MODULE_ID}";\n` +
      `const api = game.modules.get(id).api;\n` +
      `// One device-local switch: leave pocket mode if on, enter it if off. Reloads.\n` +
      `game.settings.get(id, "activation") === "never" ? api.enterPocketMode() : api.exitPocketMode();`;

    // Module packs ship locked; unlock to write, then relock so it reads as a
    // distributed (read-only) compendium.
    if (pack.locked) await pack.configure({ locked: false });
    await Macro.create(
      {
        name: "Toggle Pocket Mode",
        type: "script",
        img: "icons/svg/cog.svg",
        command,
        flags: { [MODULE_ID]: { toggle: true } }
      },
      { pack: pack.collection }
    );
    await pack.configure({ locked: true });
  } catch (err) {
    console.warn(`${MODULE_ID} | could not seed the macro compendium`, err);
  }
}

/** Register the client-scope activation setting. Call from `init`. */
export function registerActivationSettings() {
  game.settings.register(MODULE_ID, "activation", {
    name: "MOBILE_SHEET.settings.activation.name",
    hint: "MOBILE_SHEET.settings.activation.hint",
    scope: "client",
    config: true,
    type: String,
    choices: {
      auto: "MOBILE_SHEET.settings.activation.auto",
      always: "MOBILE_SHEET.settings.activation.always",
      never: "MOBILE_SHEET.settings.activation.never"
    },
    default: "auto"
  });

  // Phone = pure sheet device: drive Foundry's `core.noCanvas` so the WebGL map
  // never renders here (saves battery/memory). Client-scoped, so this device
  // only — never touches the GM's desktop.
  game.settings.register(MODULE_ID, "disableCanvasOnMobile", {
    name: "MOBILE_SHEET.settings.disableCanvasOnMobile.name",
    hint: "MOBILE_SHEET.settings.disableCanvasOnMobile.hint",
    scope: "client",
    config: true,
    type: Boolean,
    default: true
  });

  // Internal: remembers that WE flipped `core.noCanvas`, so we only ever revert
  // our own change and leave a player's manual "Disable Canvas" choice alone.
  game.settings.register(MODULE_ID, "canvasManaged", {
    scope: "client",
    config: false,
    type: Boolean,
    default: false
  });

}

// --- canvas mode -----------------------------------------------------------

/**
 * Sync Foundry's `core.noCanvas` with mobile state, then reload if it changed.
 * Canvas initializes once at startup, so the setting only takes effect after a
 * reload — we trigger exactly one. Call from the `setup` hook: core registers
 * `noCanvas` after `init` (so reading it at `init` throws), and `setup` still
 * runs before the canvas is drawn — the reload aborts the load either way.
 *
 * Two-way and idempotent:
 *   want && !off            → disable canvas, mark managed, reload.
 *   !want && off && managed → re-enable canvas, clear managed, reload.
 *   want && off && !managed → leave alone (player disabled it themselves).
 */
export async function applyMobileCanvasMode() {
  if (!game.settings.get(MODULE_ID, "disableCanvasOnMobile")) return;

  // Defensive: if core ever renames/drops the setting, don't throw — bail.
  if (!game.settings.settings.has("core.noCanvas")) {
    console.warn(`${MODULE_ID} | "core.noCanvas" not registered — skipping canvas mode`);
    return;
  }

  // Kill the canvas on a pocket device unless the user opted out via activation=never.
  // Not simply pocketModeActive(): activation=always on a desktop GM must NOT force
  // their map off — only real pocket devices ever lose the canvas.
  const want = isPocketDevice() && activationMode() !== "never";
  const off = game.settings.get("core", "noCanvas");
  const managed = game.settings.get(MODULE_ID, "canvasManaged");

  try {
    if (want && !off) {
      await game.settings.set(MODULE_ID, "canvasManaged", true);
      await game.settings.set("core", "noCanvas", true);
      console.log(`${MODULE_ID} | mobile detected — disabling canvas, reloading`);
      location.reload();
    } else if (!want && off && managed) {
      await game.settings.set(MODULE_ID, "canvasManaged", false);
      await game.settings.set("core", "noCanvas", false);
      console.log(`${MODULE_ID} | not mobile — re-enabling canvas, reloading`);
      location.reload();
    }
  } catch (err) {
    // Private/incognito tabs (notably iOS Safari) can block the localStorage
    // write that backs client settings — the canvas stays on. Surface it.
    console.warn(`${MODULE_ID} | could not set canvas mode (private tab / blocked storage?)`, err);
  }
}

// --- Dice So Nice compatibility (canvas-off) --------------------------------

/**
 * With `core.noCanvas` on, Dice So Nice bails at startup and never creates
 * `game.dice3d` — but the module still reports `active` AND still registers its
 * hooks (e.g. `createChatMessage` → `game.dice3d.renderRolls`). Daggerheart's
 * duality roll also guards its 3D presets on `module.active` (not `game.dice3d`).
 * Both then dereference the missing `game.dice3d` and throw, breaking every roll
 * on a phone. We can't patch either, so we install a no-op `game.dice3d`: a
 * Proxy whose every unknown method resolves to a harmless async no-op, with the
 * few structured bits the roll pipeline reads (DiceFactory) filled in and
 * `messageHookDisabled` set so DSN's own chat hook bows out. Produces no 3D dice
 * (there's no canvas to draw them on). Scoped: only when the canvas is off, DSN
 * is active, and nothing else has set `game.dice3d`.
 */
export function installDiceShim() {
  if (!game.settings.settings.has("core.noCanvas")) return;
  if (!game.settings.get("core", "noCanvas")) return;        // canvas on → DSN works normally
  if (!game.modules.get("dice-so-nice")?.active) return;     // DSN inactive → system guards itself
  if (game.dice3d) return;                                   // already initialized → leave it

  const noopFn = async () => true;
  const die = { appearance: {}, modelFile: null, modelLoaded: true, loadTextures: noopFn, loadModel: noopFn };
  const diceSystem = { name: "", dice: { get: () => die } };
  const base = {
    DiceFactory: { loaderGLTF: null, systems: { get: () => diceSystem } },
    messageHookDisabled: true,   // DSN's createChatMessage hook bails on this
    dice: [], box: null, uniforms: {}, hiddenAnimationQueue: [], diceLibrary: {}
  };
  game.dice3d = new Proxy(base, {
    get(target, prop, recv) {
      if (typeof prop === "symbol") return Reflect.get(target, prop, recv);
      if (prop === "then") return undefined;                 // never look thenable
      if (prop in target) return target[prop];               // own + inherited (hasOwnProperty…)
      return noopFn;                                         // any other DSN method → no-op
    }
  });
  console.log(`${MODULE_ID} | canvas off — installed no-op game.dice3d shim so rolls don't require 3D dice`);
}

// --- actor resolution ------------------------------------------------------

/** Owned actors of a type the active adapter supports (all types if no adapter). */
function ownedActors() {
  const types = resolve(game.system.id)?.actorTypes;
  return game.actors.filter(
    (a) => a.isOwner && (!types?.length || types.includes(a.type))
  );
}

/**
 * The actor to present, or null if it can't be decided alone:
 *   assigned character → sole owned supported actor → null (none / ambiguous).
 * Pure: shows no UI. Callers decide what to do with an ambiguous/none result.
 */
function resolveTargetActor() {
  const assigned = game.user.character;
  if (assigned?.isOwner) return assigned;
  const owned = ownedActors();
  if (owned.length === 1) return owned[0];
  return null;
}

// --- opening the shell -----------------------------------------------------

/** Existing PocketSheet for this actor, if one is already rendered. */
function findOpenSheet(actor) {
  for (const app of foundry.applications.instances.values()) {
    if (app instanceof PocketSheet && app.actor?.id === actor.id) return app;
  }
  return null;
}

/** Open (or surface) the mobile sheet for `actor`. No duplicate windows. */
export function openPocketSheet(actor) {
  if (!actor) return null;
  const existing = findOpenSheet(actor);
  if (existing) {
    existing.render(true);
    existing.bringToFront?.();
    return existing;
  }
  const sheet = new PocketSheet({ document: actor });
  sheet.render(true);
  return sheet;
}

// --- actor selector --------------------------------------------------------

/** Minimal owned-actor picker. Owns no document — system-agnostic (name/img/id only). */
export class ActorSelector extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: "ms-actor-selector",
    classes: ["pocket-sheets-daggerheart", "ms-actor-selector"],
    tag: "div",
    window: { title: "MOBILE_SHEET.launcher.selectTitle" },
    position: { width: 360, height: "auto" },
    actions: { pick: ActorSelector.#onPick }
  };

  static PARTS = {
    body: { template: `modules/${MODULE_ID}/templates/actor-selector.hbs` }
  };

  /** @override */
  async _prepareContext() {
    const actors = ownedActors().map((a) => ({ id: a.id, name: a.name, img: a.img }));
    return { actors };
  }

  static #onPick(event, target) {
    const actor = game.actors.get(target.dataset.actorId);
    if (actor) openPocketSheet(actor);
    this.close();
  }
}

// --- floating launcher button (FAB) ----------------------------------------

/** Inject the persistent reopen/switch button into the page body. Idempotent. */
function installLauncherFab() {
  if (document.getElementById("ms-fab")) return;

  const btn = document.createElement("button");
  btn.id = "ms-fab";
  btn.type = "button";
  btn.className = "ms-fab";
  btn.title = game.i18n.localize("MOBILE_SHEET.launcher.fabTitle");
  btn.setAttribute("aria-label", btn.title);
  btn.innerHTML = `<i class="fas fa-mobile-screen-button"></i>`;

  // Tap → reopen the current actor's sheet; fall back to the selector.
  btn.addEventListener("click", () => {
    const actor = resolveTargetActor();
    if (actor) openPocketSheet(actor);
    else if (ownedActors().length) new ActorSelector().render(true);
  });

  // Long-press / right-click → switch actor.
  const switchActor = (ev) => {
    ev.preventDefault?.();
    if (ownedActors().length) new ActorSelector().render(true);
  };
  btn.addEventListener("contextmenu", switchActor);

  let timer;
  const cancel = () => clearTimeout(timer);
  btn.addEventListener("touchstart", () => { timer = setTimeout(() => switchActor(new Event("longpress")), 500); }, { passive: true });
  btn.addEventListener("touchend", cancel, { passive: true });
  btn.addEventListener("touchmove", cancel, { passive: true });
  btn.addEventListener("touchcancel", cancel, { passive: true });

  document.body.appendChild(btn);
}

/** Inject the "enter pocket mode" button — the inverse FAB. Shown only on a pocket
 *  device that has opted out (activation=never → normal Foundry), so a desktop never
 *  sees it. Tap → switch this device back into the fullscreen sheet. Idempotent. */
function installEnterFab() {
  if (document.getElementById("ms-enter-fab")) return;

  const btn = document.createElement("button");
  btn.id = "ms-enter-fab";
  btn.type = "button";
  btn.className = "ms-fab ms-enter-fab";
  btn.title = game.i18n.localize("MOBILE_SHEET.launcher.enterTitle");
  btn.setAttribute("aria-label", btn.title);
  btn.innerHTML = `<i class="fas fa-mobile-screen-button"></i>`;
  btn.addEventListener("click", () => enterPocketMode());

  document.body.appendChild(btn);
}

// --- pocket "sheet-only" chrome -------------------------------------------

/**
 * On a pocket device (phone or tablet) with the canvas off, strip Foundry's chrome
 * (nav, sidebar, hotbar, controls, players — all under `#interface`) and let the
 * sheet fill the screen. Pure presentation: a single body class drives the CSS,
 * fully reversible. The sheet and launcher render on `<body>`, outside `#interface`,
 * so they survive. Gated on the canvas actually being off, so a device that keeps the
 * map keeps its UI too. The iPad layout itself is chosen by the sheet (see `isTablet`).
 */
export function applyMobileChrome() {
  const on = isPocketDevice() && game.settings.get("core", "noCanvas");
  document.body.classList.toggle("pocket-sheets-daggerheart-only", on);
}

// --- layout watcher (orientation / resize) ---------------------------------

/**
 * Re-evaluate layout when the viewport crosses the phone↔tablet breakpoints (rotating
 * an iPad, resizing a window). Re-applies the sheet-only chrome and re-renders any open
 * PocketSheet so it picks the right layout (1-column phone ↔ 3-pane iPad). Debounced;
 * idempotent; installed once. Pure presentation — no world data touched.
 */
let _layoutTimer;
function installLayoutWatcher() {
  const onChange = () => {
    clearTimeout(_layoutTimer);
    _layoutTimer = setTimeout(() => {
      applyMobileChrome();
      for (const app of foundry.applications.instances.values()) {
        if (app instanceof PocketSheet) app.render();
      }
    }, 150);
  };
  // matchMedia change covers orientation flips; resize covers window drags.
  window.matchMedia?.("(max-width: 768px)")?.addEventListener?.("change", onChange);
  window.matchMedia?.("(max-width: 1366px)")?.addEventListener?.("change", onChange);
  window.addEventListener("resize", onChange, { passive: true });
}

// --- entry point (call from `ready`) ---------------------------------------

/**
 * Install the launcher and, when active, auto-open the mobile sheet.
 * Call after registerPocketSheet() so the sheet class is registered.
 */
export function activateLauncher() {
  installDiceShim();
  seedToggleMacro();
  applyMobileChrome();
  installLayoutWatcher();
  // In fullscreen sheet-only mode the sheet can't be closed and carries its own
  // character switcher (tap the portrait), so the FAB is redundant — skip it.
  const sheetOnly = document.body.classList.contains("pocket-sheets-daggerheart-only");
  if (shouldShowFab() && !sheetOnly) installLauncherFab();
  // Pocket device that opted out (activation=never) → offer a way back in.
  else if (isPocketDevice() && !pocketModeActive()) installEnterFab();
  if (!shouldActivate()) return;

  const actor = resolveTargetActor();
  if (actor) { openPocketSheet(actor); return; }

  // Ambiguous: several owned actors → let the player pick. Skip the auto-popup
  // for a GM (who owns every actor) unless they have an assigned character
  // (handled above) — see spec §8 Q3.
  if (!game.user.isGM && ownedActors().length > 1) new ActorSelector().render(true);
}

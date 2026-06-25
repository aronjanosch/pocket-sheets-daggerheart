/**
 * Pocket Sheet — activation layer (Phase 3). See specs/phase-3-activation.md.
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

import { MODULE_ID } from "./constants.js";
import { resolve } from "./registry.js";
import { PocketSheet } from "./sheet.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

// --- mobile detection + activation setting ---------------------------------

/** Touch-primary AND phone/tablet-width. Both, to avoid false hits on a resized
 *  desktop window or a touch laptop. Browser-standard — identical on v13/v14. */
export function isMobile() {
  const coarse = window.matchMedia?.("(pointer: coarse)")?.matches ?? false;
  const narrow = window.matchMedia?.("(max-width: 768px)")?.matches ?? false;
  return coarse && narrow;
}

function activationMode() {
  return game.settings.get(MODULE_ID, "activation");
}

/** Should the sheet auto-open on `ready`? */
function shouldActivate() {
  const mode = activationMode();
  return mode === "always" || (mode === "auto" && isMobile());
}

/** Should the persistent launcher button exist? Always on mobile (a way back in,
 *  even when auto-open is off); on desktop only when explicitly forced on. */
function shouldShowFab() {
  return isMobile() || activationMode() === "always";
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

  const want = isMobile();
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
    classes: ["pocket-sheet", "ms-actor-selector"],
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

// --- entry point (call from `ready`) ---------------------------------------

/**
 * Install the launcher and, when active, auto-open the mobile sheet.
 * Call after registerPocketSheet() so the sheet class is registered.
 */
export function activateLauncher() {
  if (shouldShowFab()) installLauncherFab();
  if (!shouldActivate()) return;

  const actor = resolveTargetActor();
  if (actor) { openPocketSheet(actor); return; }

  // Ambiguous: several owned actors → let the player pick. Skip the auto-popup
  // for a GM (who owns every actor) unless they have an assigned character
  // (handled above) — see spec §8 Q3.
  if (!game.user.isGM && ownedActors().length > 1) new ActorSelector().render(true);
}

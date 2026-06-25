/**
 * Pocket Sheet — the core shell (v2: themed, tabbed block vocabulary).
 *
 * A registered ActorSheetV2 that renders ONLY the normalized view model from an
 * adapter (contract.js). It contains zero system knowledge: it never reads
 * `actor.system` directly. Taps become abstract Intents forwarded to
 * `adapter.invoke`, which delegates to the system.
 *
 * The shell owns chrome (theme, identity, header stats, tabs, sticky primary
 * action) and turns the adapter's declarative blocks into render-ready data
 * (pip arrays, bar percentages, active-stat highlighting). That massaging is
 * generic — it inspects only the normalized shapes, never the system.
 */

import { MODULE_ID } from "./constants.js";
import { resolve } from "./registry.js";

const { HandlebarsApplicationMixin } = foundry.applications.api;
const { ActorSheetV2 } = foundry.applications.sheets;

/** Block kinds the shell knows how to render → their partial file names. */
const KNOWN_KINDS = new Set(["resource", "statGrid", "tags", "actionList", "info", "heading"]);

/** Resource tones map to a shell-owned role color class (theming stays in shell). */
const TONE_CLASS = {
  hp: "ms-tone-hp",
  stress: "ms-tone-stress",
  armor: "ms-tone-armor",
  accent: "ms-tone-accent",
  info: "ms-tone-info"
};

const clampPct = (v, m) => (!m || m <= 0 ? 0 : Math.max(0, Math.min(100, (v / m) * 100)));

/**
 * Item-row control kinds → their shell-owned icon + intent. The adapter only
 * names the kind (and a toggle `active` state); the shell owns the chrome. Each
 * `icon`/`onIcon` is a FontAwesome class (Foundry ships FA globally).
 */
const CONTROL_DEF = {
  equip: { action: "equip", icon: "fa-solid fa-shield-halved", labelKey: "MOBILE_SHEET.action.equip" },
  vault: { action: "vault", icon: "fa-solid fa-arrow-down", onIcon: "fa-solid fa-arrow-up", labelKey: "MOBILE_SHEET.action.vault" },
  chat: { action: "toChat", icon: "fa-regular fa-message", labelKey: "MOBILE_SHEET.action.chat" }
};

export class PocketSheet extends HandlebarsApplicationMixin(ActorSheetV2) {
  /** @type {Record<string, number>} live re-render hook ids, removed on close. */
  #hookIds = {};
  /** Shell-local UI state — never written to the actor. */
  #activeTab = null;
  #activeStatKey = null;

  static DEFAULT_OPTIONS = {
    classes: ["pocket-sheet"],
    position: { width: 430, height: 860 },
    window: { resizable: true },
    actions: {
      rollStat: PocketSheet.#onRollStat,
      useItem: PocketSheet.#onUseItem,
      openItem: PocketSheet.#onOpenItem,
      toChat: PocketSheet.#onToChat,
      equip: PocketSheet.#onEquip,
      vault: PocketSheet.#onVault,
      adjustResource: PocketSheet.#onAdjustResource,
      toggleTag: PocketSheet.#onToggleTag,
      toggleItem: PocketSheet.#onToggleItem,
      primary: PocketSheet.#onPrimary,
      selectTab: PocketSheet.#onSelectTab,
      selectStat: PocketSheet.#onSelectStat
    }
  };

  static PARTS = {
    body: { template: `modules/${MODULE_ID}/templates/sheet.hbs` }
  };

  // --- render ---------------------------------------------------------------

  /** @override Build context from the adapter alone; never touch actor.system. */
  async _prepareContext(options) {
    const base = await super._prepareContext(options);

    const adapter = resolve(game.system.id);
    if (!adapter) return { ...base, state: "no-adapter", isNoAdapter: true };

    const avail = adapter.checkAvailability?.() ?? { ok: true };
    if (!avail.ok) {
      return { ...base, state: "unsupported", isUnsupported: true, reason: avail.reason };
    }

    let vm;
    try {
      vm = adapter.getViewModel(this.actor); // pure (contract §read)
    } catch (err) {
      console.error(`${MODULE_ID} | getViewModel threw`, err);
      return { ...base, state: "unsupported", isUnsupported: true, reason: "Adapter error." };
    }

    const tabs = (vm?.tabs ?? []).filter((t) => t && t.id);
    if (!tabs.length) {
      return { ...base, state: "empty", isEmpty: true, identity: this.#identity(vm) };
    }

    // Resolve shell-local selections, defaulting on first render / stale ids.
    if (!tabs.some((t) => t.id === this.#activeTab)) this.#activeTab = tabs[0].id;
    this.#ensureActiveStat(tabs);

    const active = tabs.find((t) => t.id === this.#activeTab) ?? tabs[0];
    const blocks = (active.blocks ?? [])
      .filter((b) => KNOWN_KINDS.has(b?.kind))
      .map((b) => this.#massage(b));

    const theme = this.#theme(vm.theme);
    const primary = this.#primary(vm.primary, active.blocks ?? []);

    return {
      ...base,
      state: "ok",
      isOk: true,
      theme,
      themeStyle: `--ms-accent:${theme.accent}; --ms-accent-deep:${theme.accentDeep};`,
      identity: this.#identity(vm),
      topStats: (vm.topStats ?? []).map((s) => ({ ...s, value: String(s.value) })),
      tabs: tabs.map((t) => ({ id: t.id, label: t.label, active: t.id === active.id })),
      blocks,
      primary
    };
  }

  /** Theme = the one style a system owns. Default accentDeep to accent. */
  #theme(theme) {
    const accent = theme?.accent || "#d8b35c";
    return { accent, accentDeep: theme?.accentDeep || accent };
  }

  #identity(vm) {
    const id = vm?.identity ?? {};
    return { name: id.name ?? "", img: id.img, initials: id.initials, subtitle: id.subtitle };
  }

  /** First selectable stat key across all tabs, used to arm the primary action. */
  #ensureActiveStat(tabs) {
    const keys = [];
    for (const t of tabs) {
      for (const b of t.blocks ?? []) {
        if (b?.kind !== "statGrid") continue;
        for (const s of b.stats ?? []) if (s.select && s.key) keys.push(s.key);
      }
    }
    if (!keys.includes(this.#activeStatKey)) this.#activeStatKey = keys[0] ?? null;
  }

  /** Compose the primary button; let the armed stat override its sub-line. */
  #primary(primary, activeBlocks) {
    if (!primary?.label) return null;
    let sub = primary.sub ?? "";
    for (const b of activeBlocks) {
      if (b?.kind !== "statGrid") continue;
      const s = (b.stats ?? []).find((x) => x.select && x.key === this.#activeStatKey);
      if (s) { sub = `${s.label} ${s.value}`; break; }
    }
    return { label: primary.label, sub };
  }

  /** Turn one declarative block into render-ready data. Generic, no system logic. */
  #massage(b) {
    const partial = `modules/${MODULE_ID}/templates/blocks/${b.kind}.hbs`;
    switch (b.kind) {
      case "resource": return { ...this.#resource(b), partial };
      case "statGrid": return { ...this.#statGrid(b), partial };
      case "tags": return { ...this.#tags(b), partial };
      case "actionList": return { ...this.#actionList(b), partial };
      case "heading": return { kind: b.kind, partial, label: b.label, count: b.count != null ? String(b.count) : "", hasCount: b.count != null };
      case "info":
      default: return { kind: b.kind, partial, title: b.title, hasTitle: !!b.title, html: b.html ?? "" };
    }
  }

  #resource(b) {
    const display = b.display ?? "bar";
    const hasMax = typeof b.max === "number";
    const toneClass = TONE_CLASS[b.tone] ?? TONE_CLASS.accent;
    const out = {
      kind: "resource",
      key: b.key,
      label: b.label,
      value: String(b.value ?? 0),
      max: hasMax ? String(b.max) : "",
      hasMax,
      toneClass,
      editable: b.editable !== false,
      slidable: b.editable !== false && hasMax,
      temp: b.temp != null ? `+${b.temp} TEMP` : "",
      hasTemp: b.temp != null,
      die: b.die ?? "",
      hasDie: !!b.die,
      isBar: false, isPips: false, isTracks: false
    };
    if (display === "tracks") {
      out.isTracks = true;
      out.tracks = (b.tracks ?? []).map((t) => ({
        label: t.label,
        pips: this.#pips(t.value, t.max)
      }));
    } else if ((display === "pips" || display === "diamond") && hasMax) {
      out.isPips = true;
      out.diamond = display === "diamond";
      out.small = b.max > 8;
      out.pips = this.#pips(b.value ?? 0, b.max);
    } else {
      out.isBar = true;
      out.pct = hasMax ? clampPct(b.value ?? 0, b.max) : 100;
    }
    return out;
  }

  #pips(value, max) {
    const out = [];
    for (let i = 0; i < (max ?? 0); i++) out.push({ filled: i < value, thumb: value > 0 && i === value - 1 });
    return out;
  }

  #statGrid(b) {
    const RANK = { T: ["Trained", "ms-rank-t"], E: ["Expert", "ms-rank-e"], M: ["Master", "ms-rank-m"], L: ["Legendary", "ms-rank-l"] };
    return {
      kind: "statGrid",
      cols: b.cols || 3,
      stats: (b.stats ?? []).map((s) => {
        const r = s.rank ? RANK[s.rank] : null;
        const actionName = s.select ? "selectStat" : s.rollable ? "rollStat" : "";
        return {
          key: s.key,
          label: s.label,
          value: String(s.value),
          sub: s.sub != null ? String(s.sub) : "",
          hasSub: s.sub != null,
          rankName: r ? r[0] : "",
          rankClass: r ? r[1] : "",
          hasRank: !!r,
          save: !!s.save,
          active: !!s.select && s.key === this.#activeStatKey,
          tappable: !!actionName,
          actionName
        };
      })
    };
  }

  #tags(b) {
    return {
      kind: "tags",
      items: (b.items ?? []).map((t) => ({
        key: t.key,
        label: t.label,
        value: t.value != null ? String(t.value) : "",
        hasValue: t.value != null,
        active: !!t.active
      }))
    };
  }

  #actionList(b) {
    return {
      kind: "actionList",
      title: b.title,
      hasTitle: !!b.title,
      items: (b.items ?? []).map((i) => {
        const controls = (i.controls ?? [])
          .map((c) => {
            const def = CONTROL_DEF[c.kind];
            if (!def) return null;
            return {
              itemId: i.itemId,
              action: def.action,
              icon: c.active && def.onIcon ? def.onIcon : def.icon,
              active: !!c.active,
              label: game.i18n.localize(def.labelKey)
            };
          })
          .filter(Boolean);
        const actions = (i.actions ?? []).map((a) => ({
          uuid: a.uuid,
          name: a.name,
          icon: a.icon ?? "fa-bolt",
          uses: a.uses ?? "",
          hasUses: !!a.uses
        }));
        return {
          itemId: i.itemId,
          name: i.name,
          sub: i.sub ?? "",
          hasSub: !!i.sub,
          img: i.img,
          hasImg: !!i.img,
          glyph: i.glyph ?? "",
          hasGlyph: !i.img && !!i.glyph,
          cost: i.cost ?? "",
          hasCost: i.cost != null,
          costMuted: !!i.costMuted,
          badge: i.badge ?? "",
          hasBadge: i.badge != null,
          hasToggle: i.toggle != null,
          toggleOn: !!i.toggle,
          useable: i.use !== false,
          controls,
          hasControls: controls.length > 0,
          actions,
          hasActions: actions.length > 0
        };
      })
    };
  }

  // --- intent dispatch ------------------------------------------------------

  /** Forward an Intent to the adapter. The shell never mutates/rolls itself. */
  async #dispatch(intent) {
    const adapter = resolve(game.system.id);
    if (!adapter) return;
    try {
      await adapter.invoke(this.actor, intent);
    } catch (err) {
      console.error(`${MODULE_ID} | invoke failed`, intent, err);
      ui.notifications?.error(game.i18n.localize("MOBILE_SHEET.error.actionFailed"));
    }
    // No optimistic UI: the update/roll flows back via the live re-render hooks.
  }

  static #onRollStat(event, target) {
    return this.#dispatch({ type: "rollStat", key: target.dataset.key, event });
  }

  static #onUseItem(event, target) {
    return this.#dispatch({
      type: "useItem",
      itemId: target.dataset.itemId,
      uuid: target.dataset.itemUuid,
      event
    });
  }

  static #onOpenItem(event, target) {
    return this.#dispatch({ type: "openItem", itemId: target.dataset.itemId, event });
  }

  static #onToChat(event, target) {
    return this.#dispatch({ type: "toChat", itemId: target.dataset.itemId, event });
  }

  static #onEquip(event, target) {
    return this.#dispatch({ type: "equip", itemId: target.dataset.itemId, event });
  }

  static #onVault(event, target) {
    return this.#dispatch({ type: "vault", itemId: target.dataset.itemId, event });
  }

  static #onAdjustResource(event, target) {
    return this.#dispatch({
      type: "adjustResource",
      key: target.dataset.key,
      delta: Number(target.dataset.delta) || 0,
      event
    });
  }

  static #onToggleTag(event, target) {
    return this.#dispatch({ type: "toggleTag", key: target.dataset.key, event });
  }

  static #onToggleItem(event, target) {
    return this.#dispatch({ type: "toggleItem", itemId: target.dataset.itemId, event });
  }

  static #onPrimary(event, target) {
    return this.#dispatch({ type: "primary", statKey: this.#activeStatKey, event });
  }

  // --- shell-local actions (no adapter) -------------------------------------

  static #onSelectTab(event, target) {
    this.#activeTab = target.dataset.tab;
    this.render();
  }

  static #onSelectStat(event, target) {
    this.#activeStatKey = target.dataset.key;
    this.render();
  }

  // --- secondary gesture (long-press / right-click → openItem) --------------

  /** @override Wire the secondary gesture the native `actions` map can't express. */
  _onRender(context, options) {
    super._onRender?.(context, options);
    const root = this.element;
    if (!root) return;

    for (const el of root.querySelectorAll("[data-secondary-action='openItem']")) {
      const open = (ev) => {
        ev.preventDefault();
        this.#dispatch({ type: "openItem", itemId: el.dataset.itemId, event: ev });
      };
      el.addEventListener("contextmenu", open);

      // Touch long-press (~500ms) for phones with no right-click.
      let timer;
      const cancel = () => clearTimeout(timer);
      el.addEventListener("touchstart", () => { timer = setTimeout(() => open(new Event("longpress")), 500); }, { passive: true });
      el.addEventListener("touchend", cancel, { passive: true });
      el.addEventListener("touchmove", cancel, { passive: true });
      el.addEventListener("touchcancel", cancel, { passive: true });
    }

    this.#wireResourceSliders(root);
  }

  /**
   * Slide-to-set: drag a resource track with a finger to set its value by
   * position. Painted live (optimistic), committed once on release via a
   * setResource intent — never one update per move.
   */
  #wireResourceSliders(root) {
    for (const track of root.querySelectorAll("[data-resource-drag]")) {
      const max = Number(track.dataset.max) || 0;
      const key = track.dataset.key;
      const section = track.closest(".ms-resource");
      const curEl = section?.querySelector(".ms-rv-cur");
      const fill = track.querySelector(".ms-bar-fill");
      const knob = track.querySelector(".ms-slider-knob");
      const pips = track.querySelectorAll(".ms-pip");

      const label = section?.querySelector(".ms-resource-label")?.textContent ?? "";
      const DRAG_THRESHOLD = 6; // px before a press becomes a slide

      let dragging = false;
      let moved = false;
      let downX = 0;
      let startV = 0;
      let v = 0;

      const valueFromEvent = (ev) => {
        const rect = track.getBoundingClientRect();
        const ratio = Math.max(0, Math.min(1, (ev.clientX - rect.left) / rect.width));
        return Math.max(0, Math.min(max, Math.round(ratio * max)));
      };
      const paint = (nv) => {
        v = nv;
        if (curEl) curEl.textContent = String(nv);
        const pct = max > 0 ? (nv / max) * 100 : 0;
        if (fill) fill.style.width = `${pct}%`;
        if (knob) knob.style.left = `${pct}%`;
        pips.forEach((p, i) => {
          p.classList.toggle("ms-pip-on", i < nv);
          p.classList.toggle("ms-pip-thumb", nv > 0 && i === nv - 1);
        });
      };
      const down = (ev) => {
        dragging = true;
        moved = false;
        downX = ev.clientX;
        startV = Number(curEl?.textContent) || 0;
        v = startV;
        try { track.setPointerCapture(ev.pointerId); } catch (_) {}
      };
      const move = (ev) => {
        if (!dragging) return;
        if (!moved && Math.abs(ev.clientX - downX) < DRAG_THRESHOLD) return;
        moved = true; // crossed the threshold → this is a slide, not a tap
        ev.preventDefault();
        paint(valueFromEvent(ev));
      };
      const up = (ev) => {
        if (!dragging) return;
        dragging = false;
        try { track.releasePointerCapture(ev.pointerId); } catch (_) {}
        if (moved) {
          if (v !== startV) this.#dispatch({ type: "setResource", key, value: v, event: ev });
        } else {
          this.#openResourceDialog(key, label); // a tap → +/- amount dialog
        }
      };
      const cancel = (ev) => {
        dragging = false;
        try { track.releasePointerCapture(ev.pointerId); } catch (_) {}
      };

      track.addEventListener("pointerdown", down);
      track.addEventListener("pointermove", move);
      track.addEventListener("pointerup", up);
      track.addEventListener("pointercancel", cancel);
    }
  }

  /**
   * Tap a resource track → a small dialog to add or subtract an amount. Dispatches
   * a delta via adjustResource (the adapter clamps and writes). Shell-owned UI; no
   * system knowledge.
   */
  async #openResourceDialog(key, label) {
    const DialogV2 = foundry.applications?.api?.DialogV2;
    if (!DialogV2) return;
    const safe = Handlebars.escapeExpression(label);
    const content = `<div class="ms-amt-dialog">
      <label class="ms-amt-label">${safe}</label>
      <input type="number" name="amt" class="ms-amt-input" inputmode="numeric" min="0" step="1" value="1" autofocus>
    </div>`;
    const read = (dialog) => Math.abs(Number(dialog?.element?.querySelector('input[name="amt"]')?.value) || 0);
    const delta = await DialogV2.wait({
      window: { title: label, icon: "fa-solid fa-plus-minus" },
      content,
      rejectClose: false,
      buttons: [
        { action: "sub", label: game.i18n.localize("MOBILE_SHEET.dialog.subtract"), callback: (e, b, d) => -read(d) },
        { action: "add", label: game.i18n.localize("MOBILE_SHEET.dialog.add"), default: true, callback: (e, b, d) => read(d) }
      ]
    }).catch(() => null);
    if (delta) this.#dispatch({ type: "adjustResource", key, delta });
  }

  // --- live re-render --------------------------------------------------------

  /**
   * DocumentSheetV2 already re-renders this sheet when its own actor updates.
   * The gap is embedded items, so we hook item create/update/delete scoped to
   * this actor. Core does the sync — no module sync code.
   * @override
   */
  _onFirstRender(context, options) {
    super._onFirstRender?.(context, options);
    const mine = (item) => item?.parent?.id === this.actor.id;
    const rerenderIfMine = (item) => { if (mine(item)) this.render(); };
    for (const hook of ["createItem", "updateItem", "deleteItem"]) {
      this.#hookIds[hook] = Hooks.on(hook, rerenderIfMine);
    }
  }

  /** @override Tear down the item hooks. */
  _onClose(options) {
    super._onClose?.(options);
    for (const [hook, id] of Object.entries(this.#hookIds)) Hooks.off(hook, id);
    this.#hookIds = {};
  }
}

/**
 * Register the shell as a selectable, non-default Actor sheet. If the active
 * system has an adapter, restrict to its actorTypes; otherwise register for all
 * types so opening it shows the graceful "no-adapter" state.
 */
export function registerPocketSheet() {
  const adapter = resolve(game.system.id);
  const types = adapter?.actorTypes?.length ? adapter.actorTypes : undefined;
  foundry.documents.collections.Actors.registerSheet(MODULE_ID, PocketSheet, {
    types,
    makeDefault: false,
    label: game.i18n.localize("MOBILE_SHEET.sheet.label")
  });
}

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
const KNOWN_KINDS = new Set(["resource", "statGrid", "tags", "actionList", "info", "heading", "buttons", "scale"]);

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
  chat: { action: "toChat", icon: "fa-regular fa-message", labelKey: "MOBILE_SHEET.action.chat" },
  expChat: { action: "expChat", icon: "fa-regular fa-message", labelKey: "MOBILE_SHEET.action.chat" }
};

export class PocketSheet extends HandlebarsApplicationMixin(ActorSheetV2) {
  /** @type {Record<string, number>} live re-render hook ids, removed on close. */
  #hookIds = {};
  /** Shell-local UI state — never written to the actor. */
  #activeTab = null;
  #activeStatKey = null;

  static DEFAULT_OPTIONS = {
    classes: ["pocket-sheet", "ms-sheet"],
    position: { width: 430, height: 860 },
    window: { resizable: true },
    actions: {
      rollStat: PocketSheet.#onRollStat,
      useItem: PocketSheet.#onUseItem,
      openItem: PocketSheet.#onOpenItem,
      toChat: PocketSheet.#onToChat,
      expChat: PocketSheet.#onExpChat,
      equip: PocketSheet.#onEquip,
      vault: PocketSheet.#onVault,
      rest: PocketSheet.#onRest,
      deathMove: PocketSheet.#onDeathMove,
      adjustResource: PocketSheet.#onAdjustResource,
      toggleTag: PocketSheet.#onToggleTag,
      toggleItem: PocketSheet.#onToggleItem,
      primary: PocketSheet.#onPrimary,
      openDice: PocketSheet.#onOpenDice,
      selectTab: PocketSheet.#onSelectTab,
      selectStat: PocketSheet.#onSelectStat,
      switchActor: PocketSheet.#onSwitchActor
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
      canSwitch: this.#switchableCount() > 1,
      topStats: (vm.topStats ?? []).map((s) => ({ ...s, value: String(s.value) })),
      tabs: tabs.map((t) => ({ id: t.id, label: t.label, active: t.id === active.id })),
      blocks,
      primary
    };
  }

  /** Count of owned actors the active adapter supports — drives the in-sheet
   *  character switcher (shown only when there's more than one to switch to). */
  #switchableCount() {
    const types = resolve(game.system.id)?.actorTypes;
    return (
      game.actors?.filter(
        (a) => a.isOwner && (!types?.length || types.includes(a.type))
      ).length ?? 0
    );
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
      case "buttons": return { ...this.#buttons(b), partial };
      case "scale": return { ...this.#scale(b), partial };
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
      isBar: false, isPips: false
    };
    if ((display === "pips" || display === "diamond") && hasMax) {
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
    return {
      kind: "statGrid",
      cols: b.cols || 3,
      stats: (b.stats ?? []).map((s) => {
        const actionName = s.select ? "selectStat" : s.rollable ? "rollStat" : "";
        return {
          key: s.key,
          label: s.label,
          value: String(s.value),
          sub: s.sub != null ? String(s.sub) : "",
          hasSub: s.sub != null,
          save: !!s.save,
          spellcast: !!s.spellcast,
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
              itemId: i.itemId ?? "",
              key: c.key ?? i.key ?? "",
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

  #buttons(b) {
    return {
      kind: "buttons",
      items: (b.items ?? []).map((x) => ({
        label: x.label,
        action: x.action,
        key: x.key ?? "",
        icon: x.icon ?? "",
        hasIcon: !!x.icon,
        danger: x.variant === "danger"
      }))
    };
  }

  /**
   * Compact labeled scale: interleave zone labels with the boundary values between
   * them. When the block names a `resource` and a segment carries a `mark`, that
   * zone becomes a tappable button that fires an adjustResource intent (e.g. tap a
   * damage threshold → mark that many HP). Generic: the shell only reads the
   * normalized shape, never the system.
   */
  #scale(b) {
    const segments = b.segments ?? [];
    const bounds = b.bounds ?? [];
    const resourceKey = b.resource ?? "";
    const parts = [];
    segments.forEach((s, i) => {
      const tappable = !!resourceKey && s?.mark != null;
      parts.push({
        isSegment: true,
        label: s?.label ?? "",
        sub: s?.sub ?? "",
        hasSub: !!s?.sub,
        tappable,
        resourceKey,
        delta: s?.mark != null ? String(s.mark) : ""
      });
      if (i < segments.length - 1 && bounds[i]) parts.push({ isBound: true, value: String(bounds[i].value ?? "") });
    });
    return { kind: "scale", label: b.label ?? "", hasLabel: !!b.label, parts };
  }

  // --- intent dispatch ------------------------------------------------------

  /** Forward an Intent to the adapter. The shell never mutates/rolls itself.
   *  Returns whatever the adapter resolves to (most intents: nothing; rollDice:
   *  the evaluated Roll, so the caller can echo it inline). */
  async #dispatch(intent) {
    const adapter = resolve(game.system.id);
    if (!adapter) return;
    try {
      return await adapter.invoke(this.actor, intent);
    } catch (err) {
      console.error(`${MODULE_ID} | invoke failed`, intent, err);
      ui.notifications?.error(game.i18n.localize("MOBILE_SHEET.error.actionFailed"));
    }
    // No optimistic UI: the update/roll flows back via the live re-render hooks.
  }

  static #onRollStat(event, target) {
    const label = target.querySelector(".ms-stat-label")?.textContent ?? "";
    return this.#openRollSheet(target.dataset.key, label, event);
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
    return this.#openItem(target.dataset.itemId, event);
  }

  /**
   * Open an item: prefer the adapter's in-sheet detail panel; fall back to the
   * system's desktop sheet when the adapter returns null (or has no detail at
   * all). getItemDetail is pure — a throw degrades to the fallback, never breaks.
   */
  #openItem(itemId, event) {
    const adapter = resolve(game.system.id);
    let detail = null;
    try {
      detail = adapter?.getItemDetail?.(this.actor, itemId) ?? null;
    } catch (err) {
      console.error(`${MODULE_ID} | getItemDetail threw`, err);
    }
    if (detail) return this.#openDetailSheet(detail);
    return this.#dispatch({ type: "openItem", itemId, event });
  }

  static #onToChat(event, target) {
    return this.#dispatch({ type: "toChat", itemId: target.dataset.itemId, event });
  }

  static #onExpChat(event, target) {
    return this.#dispatch({ type: "expChat", key: target.dataset.key, event });
  }

  static #onRest(event, target) {
    return this.#dispatch({ type: "rest", key: target.dataset.key, event });
  }

  static #onDeathMove(event, target) {
    return this.#dispatch({ type: "deathMove", event });
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
    const tile = this.element?.querySelector(".ms-stat-active");
    const label = tile?.querySelector(".ms-stat-label")?.textContent ?? "";
    return this.#openRollSheet(this.#activeStatKey, label, event);
  }

  static #onOpenDice() {
    return this.#openDiceRoller();
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

  /** Open the owned-actor picker. Dynamic import avoids a load-time cycle with
   *  launcher.js (which imports PocketSheet). */
  static async #onSwitchActor() {
    const { ActorSelector } = await import("./launcher.js");
    new ActorSelector().render(true);
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
        this.#openItem(el.dataset.itemId, ev);
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
          this.#openAdjustSheet({ key, label, value: Number(curEl?.textContent) || 0, max }); // tap → adjust sheet
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
   * Mount an app-like bottom sheet inside the sheet root: a dimmed backdrop and a
   * panel that slides up from the bottom. Returns the wrapper + a `close()` that
   * removes it. The caller wires the backdrop / close affordances (so an "adjust"
   * sheet can commit on dismiss while a "roll" sheet just cancels). Shell-owned
   * chrome, theme-aware via the inherited --ms-accent vars; no system knowledge.
   */
  #mountSheet(html) {
    const root = this.element?.querySelector(".ms-root") ?? this.element;
    if (!root) return null;
    root.querySelector(".ms-sheet-overlay")?.remove(); // never stack sheets
    const wrap = document.createElement("div");
    wrap.className = "ms-sheet-overlay";
    wrap.innerHTML = `<div class="ms-sheet-backdrop"></div><div class="ms-sheet-panel">${html}</div>`;
    root.appendChild(wrap);
    return { wrap, close: () => wrap.remove() };
  }

  /**
   * Tap a resource → a bottom sheet to add or subtract an amount. The preview is
   * local (live value + delta + 1/2/5/10 step); the net change commits once on
   * dismiss via a setResource intent (the adapter clamps and writes). No system
   * knowledge, no write-per-tap.
   */
  #openAdjustSheet({ key, label, value, max }) {
    const L = (k) => game.i18n.localize(`MOBILE_SHEET.dialog.${k}`);
    const hasMax = typeof max === "number" && max > 0;
    const safe = Handlebars.escapeExpression(label ?? "");
    const chips = [1, 2, 5, 10]
      .map((n, i) => `<button type="button" class="ms-amt-chip${i === 0 ? " ms-amt-on" : ""}" data-amt="${n}">${n}</button>`)
      .join("");
    const html = `
      <div class="ms-sheet-head">
        <span class="ms-sheet-title">${safe}</span>
        <button type="button" class="ms-sheet-close" aria-label="Close">✕</button>
      </div>
      <div class="ms-adj-preview">
        <span class="ms-adj-cur">${Number(value) || 0}</span>
        ${hasMax ? `<span class="ms-adj-max">/ ${max}</span>` : ""}
        <span class="ms-adj-delta"></span>
      </div>
      <div class="ms-adj-amounts">
        <span class="ms-adj-amounts-label">${L("amount")}</span>
        ${chips}
      </div>
      <div class="ms-adj-actions">
        <button type="button" class="ms-adj-sub"><span class="ms-adj-sign">−</span>${L("subtract")}</button>
        <button type="button" class="ms-adj-add"><span class="ms-adj-sign">+</span>${L("add")}</button>
      </div>
      <button type="button" class="ms-sheet-done">${L("done")}</button>`;

    const mounted = this.#mountSheet(html);
    if (!mounted) return;
    const { wrap, close } = mounted;

    const start = Number(value) || 0;
    let cur = start;
    let amt = 1;
    const curEl = wrap.querySelector(".ms-adj-cur");
    const deltaEl = wrap.querySelector(".ms-adj-delta");
    const paint = () => {
      curEl.textContent = String(cur);
      const d = cur - start;
      deltaEl.textContent = d === 0 ? "" : d > 0 ? `+${d}` : String(d);
      deltaEl.className = "ms-adj-delta" + (d > 0 ? " ms-delta-up" : d < 0 ? " ms-delta-down" : "");
    };
    const apply = (sign) => {
      let next = cur + sign * amt;
      next = Math.max(0, hasMax ? Math.min(max, next) : next);
      cur = next;
      paint();
    };
    const commitAndClose = () => {
      close();
      if (cur !== start) this.#dispatch({ type: "setResource", key, value: cur });
    };

    wrap.querySelectorAll(".ms-amt-chip").forEach((b) =>
      b.addEventListener("click", () => {
        amt = Number(b.dataset.amt) || 1;
        wrap.querySelectorAll(".ms-amt-chip").forEach((x) => x.classList.toggle("ms-amt-on", x === b));
      })
    );
    wrap.querySelector(".ms-adj-sub").addEventListener("click", () => apply(-1));
    wrap.querySelector(".ms-adj-add").addEventListener("click", () => apply(+1));
    wrap.querySelector(".ms-sheet-done").addEventListener("click", commitAndClose);
    wrap.querySelector(".ms-sheet-close").addEventListener("click", commitAndClose);
    wrap.querySelector(".ms-sheet-backdrop").addEventListener("click", commitAndClose);
  }

  /**
   * Item-detail bottom sheet: header (glyph · tag · name), a badge grid, an
   * optional description, and a column of action buttons. Each button fires the
   * action's `intent` (useItem / equip / vault / toChat / rollTrait) then closes
   * — delegation lives in the adapter, the shell only forwards. The adapter has
   * already escaped every field (`desc` is safe HTML); badges/labels still pass
   * through escapeExpression as defence in depth.
   */
  #openDetailSheet(detail) {
    const esc = (s) => Handlebars.escapeExpression(s ?? "");
    const tone = (t) => (t ? ` ${TONE_CLASS[t] ?? ""}` : "");

    const badges = (detail.badges ?? [])
      .map((b) => `
        <div class="ms-detail-badge${tone(b.tone)}">
          <span class="ms-detail-badge-label">${esc(b.label)}</span>
          <span class="ms-detail-badge-value">${esc(b.value)}</span>
        </div>`)
      .join("");

    const actions = (detail.actions ?? [])
      .map((a, i) => `
        <button type="button" class="ms-detail-act ms-detail-act-${a.variant ?? "default"}" data-i="${i}">
          <span class="ms-detail-act-label">${esc(a.label)}</span>
          ${a.sub ? `<span class="ms-detail-act-sub">${esc(a.sub)}</span>` : ""}
        </button>`)
      .join("");

    const html = `
      <div class="ms-grab"></div>
      <div class="ms-detail-head">
        <span class="ms-detail-glyph${tone(detail.iconTone)}">${esc(detail.glyph)}</span>
        <span class="ms-detail-id">
          ${detail.tag ? `<span class="ms-detail-tag${tone(detail.iconTone)}">${esc(detail.tag)}</span>` : ""}
          <span class="ms-detail-name">${esc(detail.name)}</span>
        </span>
        <button type="button" class="ms-sheet-close" aria-label="Close">✕</button>
      </div>
      ${badges ? `<div class="ms-detail-badges">${badges}</div>` : ""}
      ${detail.desc ? `<div class="ms-detail-desc">${detail.desc}</div>` : ""}
      ${actions ? `<div class="ms-detail-actions">${actions}</div>` : ""}`;

    const mounted = this.#mountSheet(html);
    if (!mounted) return;
    const { wrap, close } = mounted;
    wrap.querySelector(".ms-sheet-panel")?.classList.add("ms-detail-panel");

    wrap.querySelector(".ms-sheet-close").addEventListener("click", close);
    wrap.querySelector(".ms-sheet-backdrop").addEventListener("click", close);
    (detail.actions ?? []).forEach((a, i) => {
      wrap.querySelector(`.ms-detail-act[data-i="${i}"]`)?.addEventListener("click", (ev) => {
        close();
        this.#dispatch({ type: a.intent, itemId: a.itemId, uuid: a.uuid, key: a.key, event: ev });
      });
    });
  }

  /**
   * Open the roll bottom sheet for a stat: an Advantage / Normal / Disadvantage
   * toggle plus an optional difficulty, then Roll. Dispatches a `rollTrait` intent
   * carrying the gathered config; the adapter performs the real system roll without
   * the system's own roll dialog. Advantage/difficulty are generic enough to stay
   * shell-owned — the adapter decides how to map them. Falls back to the plain
   * primary intent when no rollable stat is armed.
   */
  #openRollSheet(key, label, event) {
    if (!key) return this.#dispatch({ type: "primary", event });
    const L = (k) => game.i18n.localize(`MOBILE_SHEET.roll.${k}`);
    const safe = Handlebars.escapeExpression(label || L("title"));
    const html = `
      <div class="ms-sheet-head">
        <span class="ms-sheet-title">${safe}</span>
        <button type="button" class="ms-sheet-close" aria-label="Close">✕</button>
      </div>
      <div class="ms-roll-adv" role="group">
        <button type="button" class="ms-adv-opt ms-adv-dis" data-adv="disadvantage">${L("disadvantage")}</button>
        <button type="button" class="ms-adv-opt ms-adv-on" data-adv="neutral">${L("normal")}</button>
        <button type="button" class="ms-adv-opt ms-adv-adv" data-adv="advantage">${L("advantage")}</button>
      </div>
      <label class="ms-roll-diff">
        <span class="ms-roll-diff-label">${L("difficulty")}</span>
        <input type="number" class="ms-roll-diff-input" inputmode="numeric" min="0" step="1" placeholder="—">
      </label>
      <button type="button" class="ms-roll-go">${L("roll")}</button>`;

    const mounted = this.#mountSheet(html);
    if (!mounted) return;
    const { wrap, close } = mounted;

    let adv = "neutral";
    wrap.querySelectorAll(".ms-adv-opt").forEach((b) =>
      b.addEventListener("click", () => {
        adv = b.dataset.adv;
        wrap.querySelectorAll(".ms-adv-opt").forEach((x) => x.classList.toggle("ms-adv-on", x === b));
      })
    );
    wrap.querySelector(".ms-sheet-close").addEventListener("click", close);
    wrap.querySelector(".ms-sheet-backdrop").addEventListener("click", close);
    wrap.querySelector(".ms-roll-go").addEventListener("click", (ev) => {
      const raw = wrap.querySelector(".ms-roll-diff-input")?.value ?? "";
      close();
      this.#dispatch({
        type: "rollTrait",
        key,
        advantage: adv,
        difficulty: raw === "" ? null : Number(raw),
        event: ev
      });
    });
  }

  /**
   * General dice roller bottom sheet: tap d4–d20 to build a pool, nudge a flat
   * modifier, then Roll. This is a generic dice tool, not a system mechanic — it
   * builds a plain core-Foundry `Roll` (zero `actor.system` access, no duality /
   * trait logic), evaluates it, shows the result inline, and posts it to chat so
   * it lands in the log like any other roll. Stays open so several rolls in a row
   * are cheap; the pool persists until cleared.
   */
  #openDiceRoller() {
    const L = (k) => game.i18n.localize(`MOBILE_SHEET.dice.${k}`);
    const DICE = ["d4", "d6", "d8", "d10", "d12", "d20"];
    const pool = Object.fromEntries(DICE.map((d) => [d, 0]));
    let mod = 0;

    const grid = DICE.map(
      (d) => `<button type="button" class="ms-die" data-die="${d}"><span class="ms-die-face">${d}</span><span class="ms-die-count" data-count="${d}"></span></button>`
    ).join("");

    const html = `
      <div class="ms-grab"></div>
      <div class="ms-sheet-head">
        <span class="ms-sheet-title">${L("title")}</span>
        <button type="button" class="ms-sheet-close" aria-label="Close">✕</button>
      </div>
      <p class="ms-dice-hint">${L("hint")}</p>
      <div class="ms-dice-grid">${grid}</div>
      <div class="ms-dice-pool"></div>
      <div class="ms-dice-mod">
        <span class="ms-dice-mod-label">${L("modifier")}</span>
        <button type="button" class="ms-dice-mod-btn" data-step="-1">−</button>
        <span class="ms-dice-mod-val">+0</span>
        <button type="button" class="ms-dice-mod-btn" data-step="1">+</button>
      </div>
      <div class="ms-dice-result" hidden></div>
      <button type="button" class="ms-roll-go ms-dice-roll" disabled>${L("roll")}</button>`;

    const mounted = this.#mountSheet(html);
    if (!mounted) return;
    const { wrap, close } = mounted;
    wrap.querySelector(".ms-sheet-panel")?.classList.add("ms-detail-panel");

    const poolEl = wrap.querySelector(".ms-dice-pool");
    const modEl = wrap.querySelector(".ms-dice-mod-val");
    const rollBtn = wrap.querySelector(".ms-dice-roll");
    const sign = (n) => (n >= 0 ? `+${n}` : `−${Math.abs(n)}`);

    const paint = () => {
      DICE.forEach((d) => {
        const btn = wrap.querySelector(`.ms-die[data-die="${d}"]`);
        const c = wrap.querySelector(`[data-count="${d}"]`);
        btn.classList.toggle("ms-die-on", pool[d] > 0);
        c.textContent = pool[d] > 0 ? String(pool[d]) : "";
      });
      modEl.textContent = sign(mod);
      const active = DICE.filter((d) => pool[d] > 0).map((d) => `${pool[d]}${d}`);
      let text = active.join(" + ");
      if (mod) text += `${active.length ? "  " : ""}${sign(mod)}`;
      poolEl.textContent = text || L("empty");
      poolEl.classList.toggle("ms-dice-pool-empty", !active.length && !mod);
      rollBtn.disabled = active.length === 0;
    };

    wrap.querySelectorAll(".ms-die").forEach((b) =>
      b.addEventListener("click", () => { pool[b.dataset.die] += 1; paint(); })
    );
    // Right-click / long-press a die to remove one.
    wrap.querySelectorAll(".ms-die").forEach((b) =>
      b.addEventListener("contextmenu", (ev) => { ev.preventDefault(); pool[b.dataset.die] = Math.max(0, pool[b.dataset.die] - 1); paint(); })
    );
    wrap.querySelectorAll(".ms-dice-mod-btn").forEach((b) =>
      b.addEventListener("click", () => { mod = Math.max(-20, Math.min(20, mod + Number(b.dataset.step))); paint(); })
    );
    wrap.querySelector(".ms-sheet-close").addEventListener("click", close);
    wrap.querySelector(".ms-sheet-backdrop").addEventListener("click", close);

    rollBtn.addEventListener("click", async () => {
      const terms = DICE.filter((d) => pool[d] > 0).map((d) => `${pool[d]}${d}`);
      if (!terms.length) return;
      let f = terms.join(" + ");
      if (mod) f += ` ${mod >= 0 ? "+" : "-"} ${Math.abs(mod)}`;
      // Delegate the actual dice math + chat card to the adapter; it hands back
      // the evaluated Roll so we can echo the result inline (chat may be hidden).
      const roll = await this.#dispatch({ type: "rollDice", formula: f });
      if (roll) this.#paintDiceResult(wrap, roll);
    });

    paint();
  }

  /** Render an evaluated Roll's per-die-type breakdown + total into the sheet. */
  #paintDiceResult(wrap, roll) {
    const el = wrap.querySelector(".ms-dice-result");
    if (!el) return;
    const groups = (roll.dice ?? [])
      .map((d) => `<div class="ms-dice-rgroup"><span class="ms-dice-rlabel">${d.number}d${d.faces}</span><span class="ms-dice-rvals">${d.results.map((r) => r.result).join("  ·  ")}</span></div>`)
      .join("");
    el.innerHTML = `<div class="ms-dice-rbreak">${groups}</div><div class="ms-dice-rtotal">${roll.total}</div>`;
    el.hidden = false;
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

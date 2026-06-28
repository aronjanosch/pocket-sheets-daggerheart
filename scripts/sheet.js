/**
 * Pocket Sheets — Daggerheart — the core shell (v2: themed, tabbed block vocabulary).
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
  /** Adapter-supplied roll-sheet augmentations (experiences, hope, bonus). */
  #rollOptions = null;
  /** Last roll's normalized result, kept so the banner survives re-renders. */
  #lastRoll = null;
  /** Top-level mode: the sheet itself, the table chat, or the journal. Shell-local. */
  #activeMode = "sheet";
  /** Journal browse state (read-only): which entry is open, which page, the search query. */
  #journalEntryId = null;
  #journalPage = 0;
  #journalQuery = "";
  /** Chat "unread" watermark: messages newer than this count toward the badge while the
   *  player is on another mode. Set to "now" at open and whenever Chat is viewed. */
  #unreadFrom = Date.now();
  /** Compose-bar draft + focus, preserved across the live re-renders chat triggers (a
   *  teammate's incoming message must not wipe a half-typed reply). */
  #chatDraft = "";
  #chatHadFocus = false;

  static DEFAULT_OPTIONS = {
    classes: ["pocket-sheets-daggerheart", "ms-sheet"],
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
      rollResourceDice: PocketSheet.#onRollResourceDice,
      toggleResourceDie: PocketSheet.#onToggleResourceDie,
      adjustItemResource: PocketSheet.#onAdjustItemResource,
      toggleTag: PocketSheet.#onToggleTag,
      toggleItem: PocketSheet.#onToggleItem,
      primary: PocketSheet.#onPrimary,
      openDice: PocketSheet.#onOpenDice,
      selectTab: PocketSheet.#onSelectTab,
      selectStat: PocketSheet.#onSelectStat,
      selectMode: PocketSheet.#onSelectMode,
      openJournalEntry: PocketSheet.#onOpenJournalEntry,
      journalBack: PocketSheet.#onJournalBack,
      journalPage: PocketSheet.#onJournalPage,
      sendChat: PocketSheet.#onSendChat,
      switchActor: PocketSheet.#onSwitchActor
    }
  };

  static PARTS = {
    body: {
      template: `modules/${MODULE_ID}/templates/sheet.hbs`,
      // Preserve scroll position of the body across re-renders (e.g. selecting a
      // trait for the duality roll must not jump the sheet back to the top).
      scrollable: [".ms-body"]
    }
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

    // Enrich any info block the adapter flagged (it can't — getViewModel is sync/pure).
    // Render-time, async, shell-owned: core Foundry enrichment, no system knowledge.
    for (const b of blocks) {
      if (b.kind === "info" && b.enrich && b.html) b.html = await this.#enrich(b.html, b.relativeToUuid);
    }

    const theme = this.#theme(vm.theme);
    const primary = this.#primary(vm.primary, active.blocks ?? []);
    this.#rollOptions = vm.primary?.rollOptions ?? null;

    // Top-level mode (Sheet / Chat / Journal). Sheet is the view model above; Chat and
    // Journal are core-Foundry, shell-owned screens built here (no adapter, no actor.system).
    const mode = this.#activeMode;
    const isChatMode = mode === "chat";
    const isJournalMode = mode === "journal";
    const isSheetMode = !isChatMode && !isJournalMode;

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
      primary,
      modes: this.#modes(isChatMode),
      isSheetMode,
      isChatMode,
      isJournalMode,
      chatPartial: `modules/${MODULE_ID}/templates/chat.hbs`,
      journalPartial: `modules/${MODULE_ID}/templates/journal.hbs`,
      chat: isChatMode ? await this.#chatContext() : null,
      journal: isJournalMode ? await this.#journalContext() : null
    };
  }

  /** The three top-level modes for the switcher, with an unread badge on Chat. */
  #modes(isChatMode) {
    const L = (k) => game.i18n.localize(`MOBILE_SHEET.mode.${k}`);
    const unread = isChatMode ? 0 : this.#unreadCount();
    return [
      { id: "sheet", label: L("sheet"), active: this.#activeMode === "sheet" },
      { id: "chat", label: L("chat"), active: isChatMode, badgeSlot: true, badge: this.#badgeText(unread) },
      { id: "journal", label: L("journal"), active: this.#activeMode === "journal" }
    ];
  }

  #badgeText(n) {
    return n > 0 ? (n > 99 ? "99+" : String(n)) : "";
  }

  /** Update the chat unread badge in place — used when chat changes while NOT in chat mode,
   *  so a table-wide message never forces a full re-render (which would wipe an open bottom
   *  sheet). The badge slot is always in the DOM, just hidden when the count is zero. */
  #paintBadge() {
    const el = this.element?.querySelector('.ms-mode[data-mode="chat"] .ms-mode-badge');
    if (!el) return;
    const text = this.#badgeText(this.#unreadCount());
    el.textContent = text;
    el.classList.toggle("ms-mode-badge-hidden", !text);
  }

  /** Count of visible messages newer than the unread watermark. */
  #unreadCount() {
    const msgs = game.messages?.contents ?? [];
    let n = 0;
    for (const m of msgs) {
      try { if (m.visible && (m.timestamp ?? 0) > this.#unreadFrom) n++; } catch (_) {}
    }
    return n;
  }

  // --- chat mode (core Foundry; no actor.system) ----------------------------

  /**
   * Build the Chat screen from the core message log. The shell owns every generic part
   * (plain bubbles, whispers, author avatars/colors, timestamps); the one system-specific
   * piece — turning a roll into a compact Hope/Fear card — is delegated to the adapter's
   * optional `getChatCard`. Messages it doesn't recognize fall back to their own rendered
   * content HTML (already core-sanitized). Reads core collections only.
   */
  async #chatContext() {
    const adapter = resolve(game.system.id);
    const msgs = (game.messages?.contents ?? []).filter((m) => {
      try { return m.visible; } catch (_) { return false; }
    });
    const messages = msgs.map((m) => this.#chatRow(m, adapter));
    return { messages, empty: messages.length === 0 };
  }

  /** One chat message → a normalized row (roll card / whisper / plain bubble). */
  #chatRow(m, adapter) {
    const author = m.alias || m.author?.name || "";
    const base = {
      author,
      color: this.#userColor(m.author),
      time: this.#formatTime(m.timestamp),
      initials: this.#initials(author),
      isSelf: m.author?.id === game.user?.id
    };

    let card = null;
    try { card = adapter?.getChatCard?.(m) ?? null; } catch (_) { card = null; }
    if (card) {
      return {
        ...base,
        isRoll: true,
        rollOutcome: card.outcome ?? "flat",
        outcome: card.label ?? "",
        total: String(card.total ?? ""),
        action: card.action ?? "",
        hasAction: !!card.action,
        hasHope: card.hope != null,
        hope: card.hope,
        hasFear: card.fear != null,
        fear: card.fear,
        hasAdv: !!card.adv,
        advValue: card.adv?.value,
        advIsAdv: card.adv?.kind === "adv",
        hasDamage: !!card.damage,
        dmgLabel: card.damage?.label ?? "",
        dmgFormula: card.damage?.formula ?? "",
        dmgTotal: card.damage?.total != null ? String(card.damage.total) : ""
      };
    }

    const isWhisper = Array.isArray(m.whisper) && m.whisper.length > 0;
    if (isWhisper) {
      return { ...base, isWhisper: true, whisperLabel: game.i18n.localize("MOBILE_SHEET.chat.whisper"), content: m.content ?? "" };
    }
    return { ...base, isMsg: true, content: m.content ?? "" };
  }

  // --- journal mode (core Foundry; read-only) -------------------------------

  /** Build the Journal screen: a searchable entry list, or the reader when one is open. */
  async #journalContext() {
    if (this.#journalEntryId) {
      const entry = game.journal?.get(this.#journalEntryId);
      if (entry?.visible) return { isReading: true, reader: await this.#journalReader(entry) };
      this.#journalEntryId = null; // stale / no longer visible → back to the list
    }
    // The full visible list ships to the client; the search box filters it live in JS
    // (see #wireJournal) so typing never re-renders and never loses input focus.
    const entries = (game.journal?.contents ?? [])
      .filter((e) => { try { return e.visible; } catch (_) { return false; } })
      .sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""))
      .map((e) => {
        const cat = this.#journalCategory(e);
        const title = e.name || game.i18n.localize("MOBILE_SHEET.journal.untitled");
        return {
          id: e.id,
          title,
          search: title.toLowerCase(),
          cat: cat.label,
          catGlyph: cat.glyph,
          meta: this.#relativeTime(e._stats?.modifiedTime)
        };
      });
    return { isList: true, query: this.#journalQuery, entries, empty: entries.length === 0 };
  }

  /** Reader view for one entry: page tabs + the active page (enriched text or image). */
  async #journalReader(entry) {
    const pages = (entry.pages?.contents ?? [])
      .filter((p) => { try { return p.visible !== false; } catch (_) { return true; } })
      .sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0));
    const idx = Math.max(0, Math.min(this.#journalPage, pages.length - 1));
    const page = pages[idx];
    const cat = this.#journalCategory(entry);

    const reader = {
      title: entry.name || game.i18n.localize("MOBILE_SHEET.journal.untitled"),
      cat: cat.label,
      byline: game.i18n.format("MOBILE_SHEET.journal.byline", { cat: cat.label, n: pages.length }),
      hasPages: pages.length > 1,
      pageTabs: pages.map((p, i) => ({
        title: p.name || game.i18n.format("MOBILE_SHEET.journal.page", { n: i + 1 }),
        page: String(i),
        active: i === idx
      }))
    };
    if (!page) { reader.empty = true; return reader; }
    if (page.type === "image" && page.src) {
      reader.isImage = true;
      reader.src = page.src;
      reader.caption = page.image?.caption ?? "";
    } else {
      reader.isText = true;
      reader.html = await this.#enrich(page.text?.content ?? "", entry.uuid);
    }
    return reader;
  }

  /** A display category for a journal entry: its folder, else its first page's type. */
  #journalCategory(entry) {
    const folder = entry.folder?.name;
    if (folder) return { label: folder, glyph: "◈" };
    const t = entry.pages?.contents?.[0]?.type ?? "text";
    const glyphs = { text: "✦", image: "🖼", pdf: "▦", video: "▷" };
    const label = game.i18n.localize(`MOBILE_SHEET.journal.cat.${t}`);
    return { label: label.startsWith("MOBILE_SHEET") ? game.i18n.localize("MOBILE_SHEET.journal.cat.text") : label, glyph: glyphs[t] ?? "✦" };
  }

  // --- shared chat/journal formatting ---------------------------------------

  #initials(name) {
    const parts = String(name ?? "").trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return "?";
    return (parts[0][0] + (parts[1]?.[0] ?? "")).toUpperCase();
  }

  #userColor(user) {
    try {
      const c = user?.color;
      if (!c) return "var(--ms-accent)";
      return typeof c === "string" ? c : (c.css ?? c.toString?.() ?? "var(--ms-accent)");
    } catch (_) {
      return "var(--ms-accent)";
    }
  }

  #formatTime(ts) {
    try {
      return new Date(ts ?? Date.now()).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    } catch (_) {
      return "";
    }
  }

  /** Coarse relative time ("3m", "2h", "5d", "2w") for journal list meta. */
  #relativeTime(ms) {
    if (!ms) return "";
    const sec = Math.max(0, Math.round((Date.now() - ms) / 1000));
    if (sec < 60) return game.i18n.localize("MOBILE_SHEET.journal.now");
    const min = Math.round(sec / 60); if (min < 60) return `${min}m`;
    const hr = Math.round(min / 60); if (hr < 24) return `${hr}h`;
    const d = Math.round(hr / 24); if (d < 7) return `${d}d`;
    const w = Math.round(d / 7); if (w < 5) return `${w}w`;
    try { return new Date(ms).toLocaleDateString(); } catch (_) { return ""; }
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
      default: return { kind: b.kind, partial, title: b.title, hasTitle: !!b.title, html: b.html ?? "", enrich: !!b.enrich, relativeToUuid: b.relativeToUuid };
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

  /**
   * An item-owned resource embedded on its own card row (Daggerheart's Seraph Prayer Dice,
   * escalating dice, class counters). Three variants: a dice pool (tap a die to spend it, a
   * button to reroll the pool), an escalating single die, or a plain counter — the latter
   * two a ± stepper. Generic: reads only the normalized shape, fires itemId-scoped intents.
   */
  #itemResource(b) {
    const toneClass = TONE_CLASS[b.tone] ?? TONE_CLASS.accent;
    const out = {
      itemId: b.itemId,
      toneClass,
      isDice: b.variant === "dice",
      img: b.img,
      hasImg: !!b.img
    };
    if (b.variant === "dice") {
      out.dice = (b.dice ?? []).map((d) => ({
        index: String(d.index),
        label: d.value != null ? String(d.value) : "?",
        unrolled: d.value == null,
        used: !!d.used
      }));
    } else {
      out.value = String(b.value ?? 0);
      out.hasMax = typeof b.max === "number";
      out.max = out.hasMax ? String(b.max) : "";
    }
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
          // Non-useable rows that still have a detail panel open it on a primary tap
          // (so a feature row isn't a dead tap target on a phone). Long-press always opens.
          openable: i.use === false && !!i.itemId,
          controls,
          hasControls: controls.length > 0,
          actions,
          hasActions: actions.length > 0,
          // An item's own resource (Prayer Dice, class counter) embedded on its card.
          resource: i.resource ? this.#itemResource(i.resource) : null,
          hasResource: !!i.resource
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

  /**
   * Enrich raw system HTML at render time (inline rolls, @UUID links, formatting) —
   * the async step the adapter's pure getViewModel/getItemDetail can't do. Resolves
   * relative to the given uuid (the item, for item-relative rolls/links) or the actor.
   * Core Foundry API only, no system knowledge. Falls back to the raw HTML on failure.
   */
  async #enrich(html, uuid) {
    try {
      const TextEditor = foundry.applications.ux.TextEditor.implementation;
      let relativeTo = this.actor;
      if (uuid) relativeTo = (await fromUuid(uuid)) ?? this.actor;
      return await TextEditor.enrichHTML(html, {
        relativeTo,
        secrets: false,
        rollData: relativeTo?.getRollData?.() ?? {}
      });
    } catch (err) {
      console.warn(`${MODULE_ID} | enrichHTML failed`, err);
      return html;
    }
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
    return this.#openTraitRoll(target.dataset.key, label, event);
  }

  static #onUseItem(event, target) {
    return this.#useAction(target.dataset.itemId, target.dataset.itemUuid, event);
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
    return this.#openRest(target.dataset.key, event);
  }

  /**
   * Open the pocket rest sheet, catching the system's desktop downtime dialog. Asks the
   * adapter what the rest offers; with a config, opens the move picker; without one,
   * falls back to a bare `rest` intent (the system's own dialog).
   */
  async #openRest(key, event) {
    const adapter = resolve(game.system.id);
    let cfg = null;
    try {
      cfg = await adapter?.getRestConfig?.(this.actor, key);
    } catch (err) {
      console.error(`${MODULE_ID} | getRestConfig threw`, err);
    }
    if (!cfg || !cfg.categories?.length) return this.#dispatch({ type: "rest", key, event });
    return this.#openRestSheet(cfg, event);
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

  static #onRollResourceDice(event, target) {
    return this.#dispatch({ type: "rollResourceDice", itemId: target.dataset.itemId, event });
  }

  static #onToggleResourceDie(event, target) {
    return this.#dispatch({ type: "toggleResourceDie", itemId: target.dataset.itemId, key: target.dataset.key, event });
  }

  static #onAdjustItemResource(event, target) {
    return this.#dispatch({ type: "adjustItemResource", itemId: target.dataset.itemId, delta: Number(target.dataset.delta) || 0, event });
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
    return this.#openTraitRoll(this.#activeStatKey, label, event);
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

  /** Switch the top-level mode (Sheet / Chat / Journal). Opening Chat clears unread. */
  static #onSelectMode(event, target) {
    const mode = target.dataset.mode;
    if (mode === this.#activeMode) return;
    this.#activeMode = mode;
    if (mode === "chat") this.#unreadFrom = Date.now();
    this.render();
  }

  static #onOpenJournalEntry(event, target) {
    this.#journalEntryId = target.dataset.id;
    this.#journalPage = 0;
    this.render();
  }

  static #onJournalBack() {
    this.#journalEntryId = null;
    this.#journalPage = 0;
    this.render();
  }

  static #onJournalPage(event, target) {
    this.#journalPage = Number(target.dataset.page) || 0;
    this.render();
  }

  static #onSendChat() {
    return this.#sendChat();
  }

  /**
   * Send the compose-bar text to the table chat. Routed through Foundry's own chat
   * processor so slash commands (/r, /w, /em, …) and plain messages all behave exactly
   * like the desktop chat input. Plain party chat is core, not a system mechanic, so the
   * shell posts it directly (the adapter is only consulted for *dice* math elsewhere).
   */
  async #sendChat() {
    const input = this.element?.querySelector(".ms-compose-input");
    const text = (input?.value ?? "").trim();
    if (!text) return;
    this.#chatDraft = "";
    if (input) input.value = "";
    try {
      // Slash commands (/r, /w, /em, …) go through Foundry's own chat processor so they
      // behave exactly like the desktop input. processMessage derives its own speaker, so
      // plain party chat is posted directly with the *open* actor as the speaker (which is
      // what the player expects when several owned characters share one device).
      if (text.startsWith("/")) {
        await ui.chat.processMessage(text);
      } else {
        await ChatMessage.implementation.create({
          content: text,
          speaker: ChatMessage.implementation.getSpeaker({ actor: this.actor })
        });
      }
    } catch (err) {
      console.error(`${MODULE_ID} | chat send failed`, err);
      ui.notifications?.error(game.i18n.localize("MOBILE_SHEET.error.actionFailed"));
    }
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
    this.#wireChat(root);
    this.#wireJournal(root);
    this.#renderBanner(); // re-attach a live roll banner after a re-render
  }

  /** Compose-bar wiring + keep the message list pinned to the newest message. */
  #wireChat(root) {
    const input = root.querySelector(".ms-compose-input");
    if (!input) return; // not in chat mode
    this.#unreadFrom = Date.now(); // everything currently shown counts as read

    input.value = this.#chatDraft; // survive the re-render a new message triggers
    input.addEventListener("input", () => { this.#chatDraft = input.value; });
    input.addEventListener("focus", () => { this.#chatHadFocus = true; });
    input.addEventListener("blur", () => { this.#chatHadFocus = false; });
    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" && !ev.shiftKey) { ev.preventDefault(); this.#sendChat(); }
    });
    if (this.#chatHadFocus) {
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length); // caret to end
    }

    // Pin to the bottom so the latest message is in view (chat reads newest-last). Deferred
    // past ApplicationV2's own scroll-position restore (which targets .ms-body) so it wins.
    const body = root.querySelector(".ms-chat-scroll");
    if (body) requestAnimationFrame(() => { body.scrollTop = body.scrollHeight; });
  }

  /** Live, focus-preserving journal search: filter the rendered list in place. */
  #wireJournal(root) {
    const search = root.querySelector(".ms-jrnl-search-input");
    if (!search) return;
    const empty = root.querySelector(".ms-jrnl-empty");
    const rows = [...root.querySelectorAll(".ms-jrnl-entry")];
    const apply = () => {
      const q = (this.#journalQuery = search.value).trim().toLowerCase();
      let shown = 0;
      for (const r of rows) {
        const hit = !q || (r.dataset.search ?? "").includes(q);
        r.style.display = hit ? "" : "none";
        if (hit) shown++;
      }
      if (empty) empty.style.display = shown === 0 ? "" : "none";
    };
    search.addEventListener("input", apply);
    apply();
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
  async #openDetailSheet(detail) {
    const esc = (s) => Handlebars.escapeExpression(s ?? "");
    const tone = (t) => (t ? ` ${TONE_CLASS[t] ?? ""}` : "");

    // Enrich the description (raw system HTML) before mounting; safe pre-escaped descs
    // (descEnrich unset) pass through untouched.
    let descHtml = detail.desc ?? "";
    if (descHtml && detail.descEnrich) descHtml = await this.#enrich(descHtml, detail.descRelativeToUuid);

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
      ${descHtml ? `<div class="ms-detail-desc">${descHtml}</div>` : ""}
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
        // useItem (weapon attack / consumable use) routes through #useAction so the
        // system's roll / spend popups are caught into pocket sheets like row taps.
        if (a.intent === "useItem") return this.#useAction(a.itemId, a.uuid, ev);
        this.#dispatch({ type: a.intent, itemId: a.itemId, uuid: a.uuid, key: a.key, event: ev });
      });
    });
  }

  /**
   * The duality roll bottom sheet, shared by trait rolls and roll actions: an
   * Advantage / Normal / Disadvantage toggle plus any adapter-supplied controls
   * (situational bonus, reaction, experiences, opt-out bonus effects). Collects the
   * choices and hands them to `onSubmit`, which fires the right intent (rollTrait or
   * useItem) — the adapter performs the real system roll without its own dialog. The
   * GM sets difficulty against the result, so the player sheet doesn't ask for it.
   */
  #openRollSheet({ title, event, opts = {}, advantage = "neutral", onSubmit } = {}) {
    const L = (k) => game.i18n.localize(`MOBILE_SHEET.roll.${k}`);
    const safe = Handlebars.escapeExpression(title || L("title"));
    const sign = (n) => (n >= 0 ? `+${n}` : `−${Math.abs(n)}`);

    const exps = opts.experiences ?? [];
    const beffs = opts.bonusEffects ?? [];
    const hopeMax = Number(opts.hope?.value) || 0; // Hope spendable right now (1 per experience).

    const advClass = (a) => (a === advantage ? " ms-adv-on" : "");

    const bonusRow = opts.bonus
      ? `<div class="ms-roll-section ms-roll-bonus-row">
           <span class="ms-roll-section-label">${L("bonus")}</span>
           <input type="text" class="ms-roll-bonus-input" inputmode="text"
                  autocapitalize="off" autocomplete="off" spellcheck="false"
                  placeholder="${L("bonusPlaceholder")}" />
         </div>`
      : "";

    const reactionRow = opts.reaction
      ? `<button type="button" class="ms-roll-toggle" data-reaction>
           <span class="ms-roll-toggle-label">${L("reaction")}</span>
           <span class="ms-roll-toggle-hint">${L("reactionHint")}</span>
         </button>`
      : "";

    const expRows = exps.length
      ? `<div class="ms-roll-section">
           <div class="ms-roll-section-head">
             <span class="ms-roll-section-label">${L("experiences")}</span>
             ${opts.hope ? `<span class="ms-roll-hope" data-hope></span>` : ""}
           </div>
           <div class="ms-roll-exps">
             ${exps
               .map(
                 (e) => `<button type="button" class="ms-roll-exp" data-exp="${Handlebars.escapeExpression(e.key)}">
               <span class="ms-roll-exp-name">${Handlebars.escapeExpression(e.name)}</span>
               <span class="ms-roll-exp-val">${sign(Number(e.value) || 0)}</span>
             </button>`
               )
               .join("")}
           </div>
         </div>`
      : "";

    // Bonus effects default ON (the system applies them); tapping opts one out of this roll.
    const beffRows = beffs.length
      ? `<div class="ms-roll-section">
           <span class="ms-roll-section-label">${L("bonusEffects")}</span>
           <div class="ms-roll-exps">
             ${beffs
               .map(
                 (e) => `<button type="button" class="ms-roll-exp ms-roll-exp-on" data-beff="${Handlebars.escapeExpression(e.id)}">
               <span class="ms-roll-exp-name">${Handlebars.escapeExpression(e.name)}</span>
             </button>`
               )
               .join("")}
           </div>
         </div>`
      : "";

    const html = `
      <div class="ms-sheet-head">
        <span class="ms-sheet-title">${safe}</span>
        <button type="button" class="ms-sheet-close" aria-label="Close">✕</button>
      </div>
      <div class="ms-roll-adv" role="group">
        <button type="button" class="ms-adv-opt ms-adv-dis${advClass("disadvantage")}" data-adv="disadvantage">${L("disadvantage")}</button>
        <button type="button" class="ms-adv-opt${advClass("neutral")}" data-adv="neutral">${L("normal")}</button>
        <button type="button" class="ms-adv-opt ms-adv-adv${advClass("advantage")}" data-adv="advantage">${L("advantage")}</button>
      </div>
      ${bonusRow}
      ${reactionRow}
      ${expRows}
      ${beffRows}
      <button type="button" class="ms-roll-go">${L("roll")}</button>`;

    const mounted = this.#mountSheet(html);
    if (!mounted) return;
    const { wrap, close } = mounted;

    let adv = advantage;
    wrap.querySelectorAll(".ms-adv-opt").forEach((b) =>
      b.addEventListener("click", () => {
        adv = b.dataset.adv;
        wrap.querySelectorAll(".ms-adv-opt").forEach((x) => x.classList.toggle("ms-adv-on", x === b));
      })
    );

    // Situational bonus → a free-text formula the player types (e.g. "1d6 + 2"),
    // passed verbatim to the system's extraFormula like its own roll dialog.
    const bonusEl = wrap.querySelector(".ms-roll-bonus-input");

    // Reaction toggle: a reaction roll generates no Fear (the adapter sets actionType).
    let reaction = false;
    const reactionBtn = wrap.querySelector("[data-reaction]");
    reactionBtn?.addEventListener("click", () => {
      reaction = !reaction;
      reactionBtn.classList.toggle("ms-roll-toggle-on", reaction);
    });

    // Experiences: tap to apply, gated by spendable Hope (1 each). The adapter
    // turns the selected ids into the system's experience modifiers + Hope cost.
    const selected = new Set();
    const hopeEl = wrap.querySelector("[data-hope]");
    const paintExps = () => {
      const left = hopeMax - selected.size;
      if (hopeEl) hopeEl.textContent = `${L("hopeLeft")}: ${left}`;
      wrap.querySelectorAll(".ms-roll-exp[data-exp]").forEach((b) => {
        const on = selected.has(b.dataset.exp);
        b.classList.toggle("ms-roll-exp-on", on);
        b.classList.toggle("ms-roll-exp-spent", !on && left <= 0);
      });
    };
    wrap.querySelectorAll(".ms-roll-exp[data-exp]").forEach((b) =>
      b.addEventListener("click", () => {
        const id = b.dataset.exp;
        if (selected.has(id)) selected.delete(id);
        else if (hopeMax - selected.size > 0) selected.add(id);
        else return; // not enough Hope to add another
        paintExps();
      })
    );
    paintExps();

    // Bonus effects: chips start on; tapping opts the effect out → collected in `off`.
    const off = new Set();
    wrap.querySelectorAll(".ms-roll-exp[data-beff]").forEach((b) =>
      b.addEventListener("click", () => {
        const id = b.dataset.beff;
        if (off.has(id)) off.delete(id);
        else off.add(id);
        b.classList.toggle("ms-roll-exp-on", !off.has(id));
      })
    );

    wrap.querySelector(".ms-sheet-close").addEventListener("click", close);
    wrap.querySelector(".ms-sheet-backdrop").addEventListener("click", close);
    wrap.querySelector(".ms-roll-go").addEventListener("click", (ev) => {
      close();
      onSubmit?.({
        advantage: adv,
        bonus: (bonusEl?.value ?? "").trim(),
        reaction,
        experiences: [...selected],
        bonusOff: [...off],
        event: ev
      });
    });
  }

  /** Open the duality roll sheet for a trait, then fire the rollTrait intent. */
  #openTraitRoll(key, label, event) {
    if (!key) return this.#dispatch({ type: "primary", event });
    const L = (k) => game.i18n.localize(`MOBILE_SHEET.roll.${k}`);
    return this.#openRollSheet({
      title: label || L("title"),
      event,
      opts: this.#rollOptions ?? {},
      onSubmit: async (c) => {
        const res = await this.#dispatch({
          type: "rollTrait",
          key,
          advantage: c.advantage,
          difficulty: null,
          experiences: c.experiences,
          bonus: c.bonus,
          reaction: c.reaction,
          bonusOff: c.bonusOff,
          event: c.event
        });
        if (res) this.#showRollBanner(res);
      }
    });
  }

  /**
   * Use an item / action via the pocket sheet, catching the desktop popups the system
   * would otherwise raise. Asks the adapter what configuring the use needs, then opens
   * the matching bottom sheet: an action picker (multi-action item), the duality roll
   * sheet (roll action), or a spend sheet (resource cost) — or just uses it directly.
   */
  async #useAction(itemId, uuid, event) {
    const adapter = resolve(game.system.id);
    let cfg = null;
    try {
      cfg = await adapter?.getActionConfig?.(this.actor, { itemId, uuid });
    } catch (err) {
      console.error(`${MODULE_ID} | getActionConfig threw`, err);
    }
    if (!cfg || cfg.kind === "direct") {
      return this.#dispatch({ type: "useItem", itemId, uuid: cfg?.uuid ?? uuid, event });
    }
    if (cfg.kind === "pick") return this.#openActionPicker(cfg.actions, event);
    if (cfg.kind === "duality") {
      return this.#openRollSheet({
        title: cfg.title,
        event,
        opts: cfg,
        advantage: cfg.advantage ?? "neutral",
        onSubmit: async (c) => {
          const res = await this.#dispatch({
            type: "useItem",
            uuid: cfg.uuid,
            advantage: c.advantage,
            experiences: c.experiences,
            reaction: c.reaction,
            bonusOff: c.bonusOff,
            bonus: c.bonus,
            event: c.event
          });
          if (res) this.#showRollBanner(res);
        }
      });
    }
    if (cfg.kind === "spend") return this.#openSpendSheet(cfg, event);
  }

  /**
   * Action picker bottom sheet: choose one of an item's actions (replaces the system's
   * desktop ActionSelectionDialog), then recurse into #useAction for that action.
   */
  #openActionPicker(actions, event) {
    const esc = (s) => Handlebars.escapeExpression(s ?? "");
    const L = (k) => game.i18n.localize(`MOBILE_SHEET.action.${k}`);
    const rows = (actions ?? [])
      .map(
        (a, i) => `<button type="button" class="ms-detail-act ms-detail-act-default" data-i="${i}">
          <span class="ms-detail-act-label">${esc(a.name)}</span>
        </button>`
      )
      .join("");
    const html = `
      <div class="ms-grab"></div>
      <div class="ms-sheet-head">
        <span class="ms-sheet-title">${esc(L("choose"))}</span>
        <button type="button" class="ms-sheet-close" aria-label="Close">✕</button>
      </div>
      <div class="ms-detail-actions">${rows}</div>`;

    const mounted = this.#mountSheet(html);
    if (!mounted) return;
    const { wrap, close } = mounted;
    wrap.querySelector(".ms-sheet-panel")?.classList.add("ms-detail-panel");
    wrap.querySelector(".ms-sheet-close").addEventListener("click", close);
    wrap.querySelector(".ms-sheet-backdrop").addEventListener("click", close);
    (actions ?? []).forEach((a, i) => {
      wrap.querySelector(`.ms-detail-act[data-i="${i}"]`)?.addEventListener("click", () => {
        close();
        this.#useAction(null, a.uuid, event);
      });
    });
  }

  /**
   * Spend sheet: confirm a non-roll action that costs resources (replaces the system's
   * desktop spend window). Shows each cost; a − n + stepper for scalable costs (clamped
   * to its max). On Spend, fires a useItem intent carrying the chosen scale per cost.
   */
  #openSpendSheet(cfg, event) {
    const esc = (s) => Handlebars.escapeExpression(s ?? "");
    const L = (k) => game.i18n.localize(`MOBILE_SHEET.spend.${k}`);
    const safe = esc(cfg.title || L("title"));
    const costs = cfg.costs ?? [];

    const rows = costs
      .map((c, i) => {
        const stepper = c.scalable
          ? `<div class="ms-roll-bonus">
               <button type="button" class="ms-dice-mod-btn" data-cstep="-1" data-ci="${i}">−</button>
               <span class="ms-spend-total" data-ctotal="${i}">${c.value}</span>
               <button type="button" class="ms-dice-mod-btn" data-cstep="1" data-ci="${i}">+</button>
             </div>`
          : `<span class="ms-spend-total">${c.value}</span>`;
        return `<div class="ms-roll-section ms-roll-bonus-row">
            <span class="ms-roll-section-label">${esc(c.label)}</span>
            ${stepper}
          </div>`;
      })
      .join("");

    const html = `
      <div class="ms-sheet-head">
        <span class="ms-sheet-title">${safe}</span>
        <button type="button" class="ms-sheet-close" aria-label="Close">✕</button>
      </div>
      ${rows}
      <button type="button" class="ms-roll-go">${L("spend")}</button>`;

    const mounted = this.#mountSheet(html);
    if (!mounted) return;
    const { wrap, close } = mounted;

    // Per-cost extra "scale" steps (0 = base cost), clamped so total ≤ max.
    const scaleBy = costs.map(() => 0);
    wrap.querySelectorAll("[data-cstep]").forEach((b) =>
      b.addEventListener("click", () => {
        const i = Number(b.dataset.ci);
        const c = costs[i];
        const maxScale = typeof c.max === "number" ? Math.max(0, Math.floor((c.max - c.value) / (c.step || 1))) : 99;
        scaleBy[i] = Math.max(0, Math.min(maxScale, scaleBy[i] + Number(b.dataset.cstep)));
        const totalEl = wrap.querySelector(`[data-ctotal="${i}"]`);
        if (totalEl) totalEl.textContent = String(c.value + scaleBy[i] * (c.step || 1));
      })
    );

    wrap.querySelector(".ms-sheet-close").addEventListener("click", close);
    wrap.querySelector(".ms-sheet-backdrop").addEventListener("click", close);
    wrap.querySelector(".ms-roll-go").addEventListener("click", (ev) => {
      close();
      const scale = {};
      costs.forEach((c, i) => { if (c.scalable) scale[c.key] = scaleBy[i]; });
      this.#dispatch({ type: "useItem", uuid: cfg.uuid, spend: true, scale, event: ev });
    });
  }

  /**
   * Rest sheet: pick a rest's downtime moves (replaces the system's desktop Downtime
   * dialog). Each category is capped at its `max`; tap a move to take it (again for
   * multiples), long-press / right-click to drop one. On Take, fires a `rest` intent
   * with the picks — the adapter posts the system's downtime card and refreshes uses.
   */
  async #openRestSheet(cfg, event) {
    const esc = (s) => Handlebars.escapeExpression(s ?? "");
    const L = (k) => game.i18n.localize(`MOBILE_SHEET.rest.${k}`);

    const cats = (cfg.categories ?? [])
      .map((cat) => {
        const moves = (cat.moves ?? [])
          .map(
            (m) => `
            <button type="button" class="ms-rest-move" data-cat="${esc(cat.key)}" data-move="${esc(m.key)}">
              ${m.icon ? `<i class="ms-rest-move-icon ${esc(m.icon)}"></i>` : ""}
              <span class="ms-rest-move-name">${esc(m.name)}</span>
              <span class="ms-rest-move-count" data-count="${esc(cat.key)}::${esc(m.key)}"></span>
            </button>`
          )
          .join("");
        const label = esc(cat.label || L(cat.key));
        return `<div class="ms-rest-cat">
            <div class="ms-rest-cat-head">
              <span class="ms-rest-cat-label">${label}</span>
              <span class="ms-rest-budget" data-budget="${esc(cat.key)}"></span>
            </div>
            <div class="ms-rest-moves">${moves}</div>
          </div>`;
      })
      .join("");

    const html = `
      <div class="ms-grab"></div>
      <div class="ms-sheet-head">
        <span class="ms-sheet-title">${esc(cfg.title || L("title"))}</span>
        <button type="button" class="ms-sheet-close" aria-label="Close">✕</button>
      </div>
      <p class="ms-rest-hint">${L("hint")}</p>
      <div class="ms-rest-cats">${cats}</div>
      <button type="button" class="ms-roll-go ms-rest-go" disabled>${L("take")}</button>`;

    const mounted = this.#mountSheet(html);
    if (!mounted) return;
    const { wrap, close } = mounted;
    wrap.querySelector(".ms-sheet-panel")?.classList.add("ms-detail-panel");

    // Selection state: { [cat]: { [move]: count } }, each category capped at its max.
    const picks = {};
    const maxOf = Object.fromEntries((cfg.categories ?? []).map((c) => [c.key, c.max]));
    const used = (cat) => Object.values(picks[cat] ?? {}).reduce((a, n) => a + n, 0);
    const goBtn = wrap.querySelector(".ms-rest-go");

    const paint = () => {
      let total = 0;
      for (const cat of cfg.categories ?? []) {
        const u = used(cat.key);
        total += u;
        const budgetEl = wrap.querySelector(`[data-budget="${cat.key}"]`);
        if (budgetEl) budgetEl.textContent = `${u} / ${cat.max}`;
        const full = u >= cat.max;
        for (const m of cat.moves ?? []) {
          const n = picks[cat.key]?.[m.key] ?? 0;
          const btn = wrap.querySelector(`.ms-rest-move[data-cat="${cat.key}"][data-move="${m.key}"]`);
          const cEl = wrap.querySelector(`[data-count="${cat.key}::${m.key}"]`);
          if (cEl) cEl.textContent = n > 0 ? `×${n}` : "";
          btn?.classList.toggle("ms-rest-move-on", n > 0);
          btn?.classList.toggle("ms-rest-move-full", full && n === 0);
        }
      }
      goBtn.disabled = total === 0;
    };

    const add = (cat, move, delta) => {
      picks[cat] ??= {};
      if (delta > 0 && used(cat) >= (maxOf[cat] ?? 0)) return; // category full
      const next = Math.max(0, (picks[cat][move] ?? 0) + delta);
      if (next === 0) delete picks[cat][move];
      else picks[cat][move] = next;
      paint();
    };

    wrap.querySelectorAll(".ms-rest-move").forEach((b) => {
      b.addEventListener("click", () => add(b.dataset.cat, b.dataset.move, +1));
      b.addEventListener("contextmenu", (ev) => { ev.preventDefault(); add(b.dataset.cat, b.dataset.move, -1); });
    });
    wrap.querySelector(".ms-sheet-close").addEventListener("click", close);
    wrap.querySelector(".ms-sheet-backdrop").addEventListener("click", close);
    goBtn.addEventListener("click", (ev) => {
      close();
      this.#dispatch({ type: "rest", key: cfg.key, picks, event: ev });
    });

    paint();
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
      if (roll) this.#showRollBanner(this.#diceResult(roll));
    });

    paint();
  }

  /** A generic evaluated Roll → the normalized RollResult the banner renders
   *  (per-die-type totals + grand total). Keeps the dice roller and duality rolls on
   *  one feedback path. */
  #diceResult(roll) {
    const dice = (roll.dice ?? []).map((d) => ({ label: `${d.number}d${d.faces}`, value: d.total }));
    return { total: roll.total, outcome: "flat", label: roll.formula ?? "", dice };
  }

  /** Record a roll result and (re)show its banner. */
  #showRollBanner(r) {
    if (!r) return;
    this.#lastRoll = r;
    this.#renderBanner();
  }

  /**
   * (Re)mount the persistent roll-result banner from #lastRoll — the in-sheet echo of a
   * roll, since chat can be hidden in phone sheet-only mode. Shows the grand total, the
   * adapter's localized outcome label, and any notable dice (Hope / Fear / per-type),
   * tinted by `outcome`. Non-blocking (the sheet stays visible, so resource changes show
   * through) and persistent: it survives re-renders and stays until dismissed or the next
   * roll replaces it. Reads only the normalized RollResult — no system knowledge.
   */
  #renderBanner() {
    const root = this.element?.querySelector(".ms-root") ?? this.element;
    if (!root) return;
    root.querySelector(".ms-banner")?.remove(); // never stack banners
    const r = this.#lastRoll;
    if (!r) return;

    const esc = (s) => Handlebars.escapeExpression(s ?? "");
    const tone = (t) => (t ? ` ${TONE_CLASS[t] ?? ""}` : "");
    const dice = (r.dice ?? [])
      .map(
        (d) => `<span class="ms-banner-die${tone(d.tone)}">
          <span class="ms-banner-die-label">${esc(d.label)}</span>
          <span class="ms-banner-die-val">${esc(d.value)}</span>
        </span>`
      )
      .join("");

    const el = document.createElement("div");
    el.className = `ms-banner ms-banner-${r.outcome ?? "flat"}`;
    el.innerHTML = `
      <span class="ms-banner-total">${esc(r.total)}</span>
      <span class="ms-banner-body">
        ${r.label ? `<span class="ms-banner-label">${esc(r.label)}</span>` : ""}
        ${dice ? `<span class="ms-banner-dice">${dice}</span>` : ""}
      </span>
      <button type="button" class="ms-banner-close" aria-label="Close">✕</button>`;
    root.appendChild(el);
    requestAnimationFrame(() => el.classList.add("ms-banner-in"));
    el.querySelector(".ms-banner-close").addEventListener("click", () => this.#dismissBanner());
  }

  /** Dismiss the banner and forget the last roll (so a re-render won't bring it back). */
  #dismissBanner() {
    this.#lastRoll = null;
    const el = this.element?.querySelector(".ms-banner");
    if (!el) return;
    el.classList.remove("ms-banner-in");
    setTimeout(() => el.remove(), 220);
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

    // Chat + journal are core-Foundry collections the shell mirrors. Only full-render for a
    // mode while it is the one on screen — a table-wide chat message must NOT re-render the
    // sheet (it would wipe an open bottom sheet); off-screen it just repaints the unread badge.
    const onChat = () => { if (this.#activeMode === "chat") this.render(); else this.#paintBadge(); };
    const onJournal = () => { if (this.#activeMode === "journal") this.render(); };
    for (const hook of ["createChatMessage", "updateChatMessage", "deleteChatMessage"]) {
      this.#hookIds[hook] = Hooks.on(hook, onChat);
    }
    for (const hook of [
      "createJournalEntry", "updateJournalEntry", "deleteJournalEntry",
      "createJournalEntryPage", "updateJournalEntryPage", "deleteJournalEntryPage"
    ]) {
      this.#hookIds[hook] = Hooks.on(hook, onJournal);
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

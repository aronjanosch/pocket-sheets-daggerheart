/**
 * Pocket Sheet — Daggerheart (Foundryborne) adapter (v2: themed, tabbed).
 *
 * The only place Daggerheart knowledge lives. Two halves:
 *   - read: getViewModel(actor) is PURE — maps actor.system → themed tabs + blocks.
 *   - act:  invoke(actor, intent) DELEGATES to the system (rollTrait / item.use /
 *           actor.update / toggleStatusEffect). Never builds a Roll or chat card.
 *
 * Reads defensively (optional chaining + fallbacks) so v13-vs-v14 / pre-2.x data
 * shape drift degrades gracefully — an absent field omits a block, never throws.
 * Fields marked VERIFY are confirmed only against a live Daggerheart 2.x world.
 *
 * @typedef {import("../scripts/contract.js").PocketSheetAdapter} PocketSheetAdapter
 */

const SYSTEM_ID = "daggerheart";
const MIN_VERSION = "2.0.0";

/** The one style this system owns. Everything else is the shell. */
const THEME = { accent: "#d8b35c", accentDeep: "#a87d36" };

/** Daggerheart's six traits, in display order. Keys pass straight to rollTrait. */
const TRAITS = ["agility", "strength", "finesse", "instinct", "presence", "knowledge"];

/** Curated conditions surfaced as toggleable tags (VERIFY ids on a live world). */
const CONDITION_IDS = ["vulnerable", "hidden", "restrained"];

/** Fallback resource maxes when the field stores `max: null` (= system default). */
const RESOURCE_MAX_DEFAULTS = { stress: 6, hope: 6 };

/** Localize an adapter string. The adapter owns Daggerheart vocabulary. */
const L = (suffix) => game.i18n.localize(`MOBILE_SHEET.daggerheart.${suffix}`);

/** Unwrap a value that may be a bare number or a `{ value }` object. */
const num = (x) => (x && typeof x === "object" ? x.value : x);

/** Signed modifier text with a real minus, e.g. +2 / −1. */
const mod = (v) => (typeof v === "number" ? (v >= 0 ? `+${v}` : `−${Math.abs(v)}`) : String(v ?? ""));

// --- helpers ----------------------------------------------------------------

/** Effective max for a resource; ResourcesField stores `max:null` for defaults. */
function resolveMax(key, res) {
  if (typeof res?.max === "number") return res.max;
  return RESOURCE_MAX_DEFAULTS[key] ?? null;
}

function clamp(n, min, max) {
  n = Math.max(min, n);
  if (typeof max === "number") n = Math.min(max, n);
  return n;
}

function resourceBlock(actor, key, label, tone, display) {
  const res = actor.system?.resources?.[key];
  if (!res) return null;
  return {
    kind: "resource",
    key,
    label,
    tone,
    display,
    value: res.value ?? 0,
    max: resolveMax(key, res),
    editable: true
  };
}

function conditionsBlock(actor) {
  const defs = new Map((CONFIG?.statusEffects ?? []).map((s) => [s.id, s]));
  const active = actor.statuses ?? new Set();
  const items = CONDITION_IDS
    .map((id) => {
      const def = defs.get(id);
      if (!def) return null;
      return { key: id, label: game.i18n.localize(def.name ?? def.label ?? id), active: active.has?.(id) };
    })
    .filter(Boolean);
  return items.length ? { kind: "tags", items } : null;
}

function traitsGrid(actor) {
  const sys = actor.system ?? {};
  let scKey = null;
  try { scKey = sys.spellcastModifierTrait?.key ?? null; } catch (_) { scKey = null; }
  const stats = TRAITS.map((key) => {
    const v = num(sys.traits?.[key]?.value ?? sys.traits?.[key]) ?? 0;
    const stat = { key, label: L(`trait.${key}`).slice(0, 3), value: mod(v), select: true };
    if (key === scKey) stat.spellcast = true;
    return stat;
  });
  return { kind: "statGrid", cols: 3, stats };
}

/**
 * Damage thresholds as a compact scale below HP: the Minor / Major / Severe zones
 * (1 / 2 / 3 HP marked) split by the Major and Severe boundary values.
 */
function thresholdsScale(actor) {
  const t = actor.system?.damageThresholds;
  if (!t) return null;
  const major = num(t.major);
  const severe = num(t.severe);
  if (major == null && severe == null) return null;
  return {
    kind: "scale",
    label: L("heading.thresholds"),
    segments: [
      { label: L("threshold.minor") },
      { label: L("threshold.major") },
      { label: L("threshold.severe") }
    ],
    bounds: [{ value: major ?? 0 }, { value: severe ?? 0 }]
  };
}

/** Death-move button — only when the system says all HP are marked (viable). */
function deathMoveButton(actor) {
  let viable = false;
  try { viable = !!actor.system?.deathMoveViable; } catch (_) { viable = false; }
  if (!viable || !game.system?.api?.applications?.dialogs?.DeathMove) return null;
  return {
    kind: "buttons",
    items: [{ label: L("deathMove"), action: "deathMove", icon: "fa-skull", variant: "danger" }]
  };
}

/** Short / Long rest — open the system's own Downtime dialog. Omitted if absent. */
function restButtons() {
  if (!game.system?.api?.applications?.dialogs?.Downtime) return null;
  return {
    kind: "buttons",
    items: [
      { label: L("rest.short"), action: "rest", key: "short", icon: "fa-mug-hot" },
      { label: L("rest.long"), action: "rest", key: "long", icon: "fa-campground" }
    ]
  };
}

function itemRows(actor, types, map) {
  const list = actor.items?.filter((i) => types.includes(i.type)) ?? [];
  return list.map(map);
}

/** A function on a document, regardless of own vs prototype. */
const can = (doc, method) => typeof doc?.[method] === "function";

/** Normalize an item's embedded actions (Collection | array) to a flat list. */
function actionList(item) {
  const a = item?.system?.actions;
  if (!a) return [];
  if (Array.isArray(a)) return a;
  if (typeof a.values === "function") return [...a.values()];
  if (Array.isArray(a.contents)) return a.contents;
  return [];
}

/** Inline buttons for an item's own actions (the "Mark a Stress" affordances). */
function actionButtons(item) {
  return actionList(item)
    .map((a) => {
      if (!a?.uuid) return null;
      const btn = { uuid: a.uuid, name: a.name ?? "", icon: a.typeIcon };
      const max = a.uses?.max;
      if (max) btn.uses = `${a.remainingUses ?? 0}/${max}`;
      return btn;
    })
    .filter(Boolean);
}

/** Post-to-chat control, present only when the item supports it. */
function chatControl(item) {
  return can(item, "toChat") ? [{ kind: "chat" }] : [];
}

function attachActions(row, item) {
  const acts = actionButtons(item);
  if (acts.length) row.actions = acts;
  return row;
}

function domainCardRow(item) {
  const domain = item.system?.domain ?? "";
  const level = num(item.system?.level);
  const sub = [domain, level != null ? `${L("label.level")} ${level}` : null].filter(Boolean).join(" · ");
  const row = { itemId: item.id, name: item.name, img: item.img, glyph: "✦", sub, use: can(item, "use") };
  const recall = num(item.system?.recallCost ?? item.system?.recall);
  if (typeof recall === "number" && recall > 0) { row.cost = `↺${recall}`; row.costMuted = true; }
  attachActions(row, item);
  row.controls = [{ kind: "vault", active: !!item.system?.inVault }, ...chatControl(item)];
  return row;
}

/** Loadout = the two domain-card piles the system maintains: loadout and vault. */
function loadoutTab(actor) {
  const dc = actor.system?.domainCards;
  const loadout = dc?.loadout ?? [];
  const vault = dc?.vault ?? [];
  const blocks = [];
  if (loadout.length) {
    blocks.push({ kind: "heading", label: L("heading.loadout"), count: loadout.length });
    blocks.push({ kind: "actionList", items: loadout.map(domainCardRow) });
  }
  if (vault.length) {
    blocks.push({ kind: "heading", label: L("heading.vault"), count: vault.length });
    blocks.push({ kind: "actionList", items: vault.map(domainCardRow) });
  }
  return blocks;
}

function weaponRow(w) {
  const trait = w.system?.trait ?? "";
  const range = w.system?.range ?? "";
  const damage = num(w.system?.damage) ?? w.system?.damage?.value ?? "";
  const row = {
    itemId: w.id, name: w.name, img: w.img, glyph: "⚔",
    sub: [trait, range].filter(Boolean).join(" · "),
    use: can(w, "use")
  };
  if (damage) row.badge = String(damage);
  attachActions(row, w);
  row.controls = [{ kind: "equip", active: !!w.system?.equipped }, ...chatControl(w)];
  return row;
}

function armorRow(a) {
  const score = num(a.system?.baseScore ?? a.system?.score);
  const row = { itemId: a.id, name: a.name, img: a.img, glyph: "🛡", use: can(a, "use") };
  if (score != null) row.badge = String(score);
  attachActions(row, a);
  row.controls = [{ kind: "equip", active: !!a.system?.equipped }, ...chatControl(a)];
  return row;
}

function stuffRow(i) {
  const qty = num(i.system?.quantity);
  const row = {
    itemId: i.id, name: i.name, img: i.img, glyph: "◈",
    sub: typeof qty === "number" && qty > 1 ? `×${qty}` : "",
    use: can(i, "use")
  };
  attachActions(row, i);
  const controls = chatControl(i);
  if (controls.length) row.controls = controls;
  return row;
}

function featureRow(item) {
  const row = { itemId: item.id, name: item.name, img: item.img, use: can(item, "use") };
  attachActions(row, item);
  const controls = chatControl(item);
  if (controls.length) row.controls = controls;
  return row;
}

/**
 * Features grouped by their source the way the system sheet groups them:
 * Ancestry / Community / Class / Subclass / Companion, then loose features.
 * Reuses the system's own `sheetLists` getter so grouping stays correct; falls
 * back to a flat feature list if that getter is unavailable on this version.
 */
function featuresTab(actor) {
  const blocks = [...experiencesBlocks(actor)];

  let lists = null;
  try { lists = actor.system?.sheetLists; } catch (_) { lists = null; }

  if (lists && typeof lists === "object") {
    for (const cat of Object.values(lists)) {
      const vals = cat?.values ?? [];
      if (!vals.length) continue;
      blocks.push({ kind: "heading", label: cat.title ?? L("heading.features"), count: vals.length });
      blocks.push({ kind: "actionList", items: vals.map(featureRow) });
    }
    return blocks;
  }

  const rows = itemRows(actor, ["ancestry", "community", "class", "subclass", "feature"], featureRow);
  if (rows.length) {
    blocks.push({ kind: "heading", label: L("heading.features") });
    blocks.push({ kind: "actionList", items: rows });
  }
  return blocks;
}

/** Experiences as tappable rows, each able to post itself to chat (like the system sidebar). */
function experiencesBlocks(actor) {
  const exp = actor.system?.experiences;
  const entries = exp ? Object.entries(exp) : [];
  if (!entries.length) return [];
  const items = entries.map(([id, e]) => {
    const v = e?.value;
    const prefix = typeof v === "number" ? `${mod(v)} ` : "";
    return {
      key: id,
      name: `${prefix}${e?.name ?? ""}`.trim(),
      glyph: "✶",
      use: false,
      controls: [{ kind: "expChat", key: id }]
    };
  });
  return [
    { kind: "heading", label: L("list.experiences"), count: items.length },
    { kind: "actionList", items }
  ];
}

/** Inventory: gold, then the system's inventory categories with equip controls. */
function itemsTab(actor) {
  const blocks = [];

  const gold = actor.system?.gold;
  if (gold && typeof gold === "object") {
    const tile = (key) => ({ label: L(`gold.${key}`), value: gold[key] ?? 0 });
    const stats = ["handfuls", "bags", "chests"].filter((k) => gold[k] != null).map(tile);
    if (stats.length) {
      blocks.push({ kind: "heading", label: L("heading.gold") });
      blocks.push({ kind: "statGrid", cols: stats.length, stats });
    }
  }

  const sections = [
    ["weapon", weaponRow],
    ["armor", armorRow],
    ["consumable", stuffRow],
    ["loot", stuffRow]
  ];
  for (const [type, map] of sections) {
    const rows = itemRows(actor, [type], map);
    if (!rows.length) continue;
    blocks.push({ kind: "heading", label: typeLabel(type), count: rows.length });
    blocks.push({ kind: "actionList", items: rows });
  }
  return blocks;
}

function bioTab(actor) {
  const sys = actor.system ?? {};
  const raw = sys.details?.biography ?? sys.biography ?? sys.background;
  const text = typeof raw === "string" ? raw : raw?.value;
  if (!text || typeof text !== "string" || !text.trim()) return [];
  // getViewModel is sync/pure → cannot enrich (async). Escape owner-supplied text.
  // VERIFY: switch to pre-enriched HTML once a render-time enrich hook exists.
  return [{ kind: "info", title: L("heading.background"), html: `<p>${Handlebars.escapeExpression(text)}</p>` }];
}

function typeLabel(type) {
  const key = `type.${type}`;
  const full = `MOBILE_SHEET.daggerheart.${key}`;
  const localized = game.i18n.localize(full);
  return localized === full ? type.charAt(0).toUpperCase() + type.slice(1) : localized;
}

function buildIdentity(actor) {
  const cls = actor.items?.find((i) => i.type === "class")?.name;
  const sub = actor.items?.find((i) => i.type === "subclass")?.name;
  const level = num(actor.system?.level);

  const parts = [];
  if (typeof level === "number" || (typeof level === "string" && level)) parts.push(`${L("label.level")} ${level}`);
  if (cls) parts.push(sub ? `${cls} · ${sub}` : cls);

  const initials = (actor.name ?? "")
    .split(/\s+/)
    .map((w) => w[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();

  const identity = { name: actor.name, img: actor.img, initials };
  if (parts.length) identity.subtitle = parts.join(" · ");
  return identity;
}

function topStats(actor) {
  const sys = actor.system ?? {};
  const out = [];
  const evasion = num(sys.evasion);
  if (evasion != null) out.push({ label: L("stat.evasion"), value: evasion });
  const prof = num(sys.proficiency);
  if (prof != null) out.push({ label: L("stat.proficiency"), value: mod(prof), accent: true });
  return out;
}

function writeResource(actor, key, next) {
  const res = actor.system?.resources?.[key];
  if (!res) return;
  const clamped = clamp(next, 0, resolveMax(key, res));
  return actor.update({ [`system.resources.${key}.value`]: clamped });
}

function adjustResource(actor, key, delta) {
  const res = actor.system?.resources?.[key];
  if (!res) return;
  return writeResource(actor, key, (res.value ?? 0) + delta);
}

/** Toggle equipped. Armor is exclusive (only one worn) — unequip the other first. */
async function toggleEquip(actor, itemId) {
  const item = actor.items?.get(itemId);
  if (!item) return;
  if (item.system?.equipped) return item.update({ "system.equipped": false });
  if (item.type === "armor") {
    const worn = actor.items.find((i) => i.type === "armor" && i.system?.equipped && i.id !== item.id);
    if (worn) await worn.update({ "system.equipped": false });
  }
  return item.update({ "system.equipped": true });
}

/** Post an item to chat via the system's own card builder. */
function postToChat(actor, itemId) {
  const item = actor.items?.get(itemId);
  return can(item, "toChat") ? item.toChat(item.uuid) : undefined;
}

/** Move a domain card between loadout and vault. */
function toggleVault(actor, itemId) {
  const item = actor.items?.get(itemId);
  if (!item) return;
  return item.update({ "system.inVault": !item.system?.inVault });
}

/** Use an item, or one of its embedded actions when an action uuid is given. */
async function useItem(actor, intent) {
  if (intent.uuid) {
    const action = await fromUuid(intent.uuid);
    return can(action, "use") ? action.use({}) : undefined;
  }
  return actor.items?.get(intent.itemId)?.use?.(intent.event);
}

/** Open the system's Downtime (rest) dialog for a short or long rest. */
function openRest(actor, key) {
  const Downtime = game.system?.api?.applications?.dialogs?.Downtime;
  if (!Downtime) return;
  return new Downtime(actor, key === "short").render({ force: true });
}

/** Map a shell advantage choice to the system's advantageState value (adv +1 / dis −1). */
function advantageValue(choice) {
  const state = CONFIG?.DH?.ACTIONS?.advantageState;
  if (choice === "advantage") return state?.advantage?.value ?? 1;
  if (choice === "disadvantage") return state?.disadvantage?.value ?? -1;
  return undefined; // neutral → let the system roll straight
}

/**
 * Roll a trait with our own config, skipping the system's roll dialog.
 * `dialog.configure:false` is the documented off-switch in DHRoll.buildConfigure
 * (2.x); the system still builds the Roll and posts the chat card — we never fake
 * dice. Falls back to the normal dialog roll when no config is supplied.
 */
function rollTraitDirect(actor, intent) {
  if (typeof actor.rollTrait !== "function") return;
  const roll = { trait: intent.key, type: "trait" };
  const adv = advantageValue(intent.advantage);
  if (adv != null) roll.advantage = adv;
  if (intent.difficulty != null && !Number.isNaN(Number(intent.difficulty))) {
    roll.difficulty = Number(intent.difficulty);
  }
  return actor.rollTrait(intent.key, { dialog: { configure: false }, roll, event: intent.event });
}

/** Open the system's Death Move dialog (when all HP are marked). */
function openDeathMove(actor) {
  const DeathMove = game.system?.api?.applications?.dialogs?.DeathMove;
  if (!DeathMove) return;
  return new DeathMove(actor).render({ force: true });
}

/**
 * Post an experience to chat. There is no document method for this — the system
 * builds the card inline in its sheet — so we mirror that build, reusing the
 * system's own chat template + flags so the card matches.
 */
async function experienceToChat(actor, id) {
  const exp = actor.system?.experiences?.[id];
  if (!exp) return;
  const cls = getDocumentClass("ChatMessage");
  const value = typeof exp.value === "number" ? exp.value : 0;
  const signed = typeof value.signedString === "function" ? value.signedString() : mod(value);
  const systemData = {
    actor: { name: actor.name, img: actor.img },
    author: game.users.get(game.user.id),
    action: { name: `${exp.name ?? ""} ${signed}`.trim(), img: "/icons/sundries/misc/admission-ticket-blue.webp" },
    itemOrigin: { name: L("list.experiences") },
    description: exp.description ?? ""
  };
  const content = await foundry.applications.handlebars.renderTemplate(
    "systems/daggerheart/templates/ui/chat/action.hbs",
    systemData
  );
  return cls.create({
    user: game.user.id,
    content,
    speaker: cls.getSpeaker(),
    flags: { daggerheart: { cssClass: "dh-chat-message dh-style" } }
  });
}

// --- adapter -----------------------------------------------------------------

/** @type {PocketSheetAdapter} */
export const daggerheartAdapter = {
  systemId: SYSTEM_ID,
  actorTypes: ["character"],

  /** The version seam. Cheap, side-effect-free, never throws. */
  checkAvailability() {
    if (game.system?.id !== SYSTEM_ID) return { ok: false, reason: L("unsupported.api") };

    const hasDuality = !!CONFIG?.Dice?.daggerheart?.DualityRoll;
    const hasRollTrait = typeof CONFIG?.Actor?.documentClass?.prototype?.rollTrait === "function";
    if (!hasDuality || !hasRollTrait) return { ok: false, reason: L("unsupported.api") };

    const okVersion = !foundry.utils.isNewerVersion(MIN_VERSION, game.system.version ?? "0");
    if (!okVersion) return { ok: false, reason: L("unsupported.version") };

    return { ok: true };
  },

  /** PURE: actor.system → themed, tabbed view model. No async, no DOM, no writes. */
  getViewModel(actor) {
    const vitals = [
      deathMoveButton(actor),
      conditionsBlock(actor),
      resourceBlock(actor, "hitPoints", L("resource.hitPoints"), "hp", "pips"),
      thresholdsScale(actor),
      resourceBlock(actor, "stress", L("resource.stress"), "stress", "pips"),
      resourceBlock(actor, "hope", L("resource.hope"), "accent", "diamond"),
      resourceBlock(actor, "armor", L("resource.armor"), "armor", "pips"),
      { kind: "heading", label: L("heading.traits") },
      traitsGrid(actor),
      restButtons()
    ].filter(Boolean);

    const loadout = loadoutTab(actor);

    const tabs = [{ id: "vitals", label: L("tab.vitals"), blocks: vitals }];
    const features = featuresTab(actor);
    if (features.length) tabs.push({ id: "features", label: L("tab.features"), blocks: features });
    if (loadout.length) tabs.push({ id: "loadout", label: L("tab.loadout"), blocks: loadout });
    const items = itemsTab(actor);
    if (items.length) tabs.push({ id: "items", label: L("tab.items"), blocks: items });
    const bio = bioTab(actor);
    if (bio.length) tabs.push({ id: "bio", label: L("tab.bio"), blocks: bio });

    return {
      theme: THEME,
      identity: buildIdentity(actor),
      topStats: topStats(actor),
      tabs,
      primary: { label: L("primary.duality") }
    };
  },

  /** Delegate each intent to the system's own method. Unknown intent → no-op. */
  async invoke(actor, intent) {
    switch (intent.type) {
      case "rollTrait":
        return rollTraitDirect(actor, intent);
      case "primary":
      case "rollStat":
        // Fallback path (no roll-sheet config) → the system's own roll dialog.
        return actor.rollTrait?.(intent.statKey ?? intent.key, { event: intent.event });
      case "useItem":
        return useItem(actor, intent);
      case "openItem":
        return actor.items.get(intent.itemId)?.sheet?.render(true);
      case "toChat":
        return postToChat(actor, intent.itemId);
      case "expChat":
        return experienceToChat(actor, intent.key);
      case "equip":
        return toggleEquip(actor, intent.itemId);
      case "vault":
        return toggleVault(actor, intent.itemId);
      case "rest":
        return openRest(actor, intent.key);
      case "deathMove":
        return openDeathMove(actor);
      case "adjustResource":
        return adjustResource(actor, intent.key, intent.delta);
      case "setResource":
        return writeResource(actor, intent.key, intent.value);
      case "toggleTag":
        return actor.toggleStatusEffect?.(intent.key);
      default:
        return;
    }
  }
};

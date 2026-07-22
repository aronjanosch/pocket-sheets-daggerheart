/**
 * Daggerheart (Foundryborne) adapter (v2: themed, tabbed).
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

/** Item types shown on the Features tab and given an in-sheet detail panel. */
const FEATURE_TYPES = ["ancestry", "community", "class", "subclass", "feature", "companion"];

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

/**
 * Resolve an item-resource formula (`resource.max`) to a number, the way the system
 * does (itemAbleRollParse): an `item.@…` formula reads the item's roll data, anything
 * else reads the actor's. PURE/sync — safe inside getViewModel. Null when unresolvable.
 */
function parseItemFormula(formula, actor, item) {
  if (formula == null || formula === "") return null;
  if (typeof formula === "number") return formula;
  try {
    const isItemTarget = String(formula).toLowerCase().includes("item.@");
    const sliced = isItemTarget ? String(formula).replaceAll(/item\.@/gi, "@") : String(formula);
    const data = (isItemTarget ? item?.getRollData?.() : actor?.getRollData?.()) ?? {};
    const replaced = Roll.replaceFormulaData(sliced, data);
    const n = Number(replaced);
    if (Number.isFinite(n)) return n;
    const total = new Roll(replaced).evaluateSync({ strict: false }).total;
    return Number.isFinite(total) ? total : null;
  } catch (_) {
    return null;
  }
}

/** Localize a system CONFIG key id, degrading to the raw id when the key is unknown
 *  (a homebrew value or a version whose CONFIG doesn't define it). */
function localizeConfigKey(key, id) {
  if (!id) return "";
  const has = typeof game.i18n.has === "function" ? game.i18n.has(key) : true;
  return has ? game.i18n.localize(key) : String(id);
}

/** A weapon trait id ("agility") → its display name, per the system's CONFIG.Traits. */
function traitLabel(id) {
  return localizeConfigKey(`DAGGERHEART.CONFIG.Traits.${id}.name`, id);
}

/** A weapon range id ("melee") → its display name, per the system's CONFIG.Range. */
function rangeLabel(id) {
  return localizeConfigKey(`DAGGERHEART.CONFIG.Range.${id}.name`, id);
}

/** A weapon burden id ("oneHanded") → its display name, per the system's CONFIG.Burden. */
function burdenLabel(id) {
  return localizeConfigKey(`DAGGERHEART.CONFIG.Burden.${id}`, id);
}

/**
 * A weapon's attack damage, 2.5.x shape: `system.attack.damage.parts` is an id-keyed
 * collection of `DHDamageData` (see DamageField); pick the part applying to hitPoints
 * (the system's own damage roll order), or the first, and read its formula off the
 * embedded `DHActionDiceData` via its sync `getFormula()`. `@…` references are resolved
 * for display against the actor's roll data ("@profd12" → "2d12"), the way the system's
 * own label build does (weapon.mjs _getLabels). Falls back to the pre-2.x flat
 * `system.damage` field. Null when neither shape is present.
 */
function weaponDamage(item) {
  const sys = item?.system ?? {};
  const parts = sys.attack?.damage?.parts;
  const list = parts ? Object.values(parts) : [];
  const part = list.find((p) => p?.applyTo === "hitPoints") ?? list[0];
  let formula = typeof part?.value?.getFormula === "function" ? part.value.getFormula() : null;
  if (formula) {
    try { formula = Roll.replaceFormulaData(formula, item?.actor?.getRollData?.() ?? {}); } catch (_) {}
    return { formula, types: part.type ? [...part.type] : [] };
  }

  const legacy = num(sys.damage) ?? sys.damage?.value;
  if (legacy == null || legacy === "") return null;
  const legacyType = sys.damageType ?? sys.damage?.type;
  return { formula: String(legacy), types: legacyType ? [legacyType] : [] };
}

/** Faces count from a die-faces string ("d12" → 12), or null. */
function dieFacesMax(faces) {
  const n = Number(String(faces ?? "").split("d")[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Hope-die svg the system ships for a given die size — lets the pocket sheet show the
 *  same dice the default/sleek sheets do. */
function dieFacesImg(faces) {
  return `systems/${SYSTEM_ID}/assets/icons/dice/hope/${faces ?? "d4"}.svg`;
}

/**
 * One owned item's `system.resource` → the resource descriptor embedded on that item's
 * row (so a Seraph's Prayer Dice live on the Prayer Dice card, not a detached list), or
 * null when the item carries no resource. Three system shapes (itemResourceTypes):
 *   - diceValue: a pool of dice (Seraph Prayer Dice) — each die has a rolled value and a
 *                spent flag; the player rerolls the pool and taps a die to spend it.
 *   - die      : a single escalating die (value 0…faces) advanced with the stepper.
 *   - simple   : a plain counter (value 0…max), `max` a formula resolved per actor/item.
 */
function itemResourceFor(actor, item) {
  const res = item?.system?.resource;
  if (!res || !res.type) return null;

  if (res.type === "diceValue") {
    const count = parseItemFormula(res.max, actor, item) ?? 0;
    const states = res.diceStates ?? {};
    const dice = [];
    for (let i = 0; i < count; i++) {
      const s = states[i] ?? states[String(i)];
      dice.push({ index: i, value: s?.value ?? null, used: !!s?.used });
    }
    return { variant: "dice", itemId: item.id, img: dieFacesImg(res.dieFaces), dice };
  }

  if (res.type === "die") {
    return { variant: "die", itemId: item.id, img: dieFacesImg(res.dieFaces), value: res.value ?? 0, max: dieFacesMax(res.dieFaces) };
  }

  return { variant: "count", itemId: item.id, value: res.value ?? 0, max: parseItemFormula(res.max, actor, item) };
}

/** Attach an item's own resource (Prayer Dice, class counter) to its row, when present. */
function attachResource(row, item) {
  const res = itemResourceFor(item.actor ?? item.parent, item);
  if (res) row.resource = res;
  return row;
}

/** Reroll a dice-pool resource: roll `count d<faces>`, post the dice to chat, and write
 *  the fresh (unspent) values — the pocket equivalent of the system's ResourceDiceDialog. */
async function rerollItemDice(actor, itemId) {
  const item = actor.items?.get(itemId);
  const res = item?.system?.resource;
  if (!res || res.type !== "diceValue") return;
  const count = parseItemFormula(res.max, actor, item) ?? 0;
  if (count <= 0) return;
  const roll = await new Roll(`${count}${res.dieFaces ?? "d4"}`).evaluate();
  await roll.toMessage({ speaker: ChatMessage.getSpeaker({ actor }), flavor: item.name });
  const results = roll.terms?.[0]?.results ?? [];
  const diceStates = results.reduce((acc, r, i) => { acc[i] = { value: r.result, used: false }; return acc; }, {});
  return item.update({ "system.resource.diceStates": diceStates });
}

/** Toggle one die of a dice-pool resource spent/unspent (mirrors #toggleResourceDice). */
function toggleItemDie(actor, itemId, index) {
  const item = actor.items?.get(itemId);
  const res = item?.system?.resource;
  if (!res || res.type !== "diceValue") return;
  const state = res.diceStates?.[index];
  return item.update({ [`system.resource.diceStates.${index}.used`]: state ? !state.used : true });
}

/** Step a simple/die item resource's value, clamped to [0, max] (faces for a die). */
function adjustItemResource(actor, itemId, delta) {
  const item = actor.items?.get(itemId);
  const res = item?.system?.resource;
  if (!res) return;
  const max = res.type === "die" ? dieFacesMax(res.dieFaces) : parseItemFormula(res.max, actor, item);
  return item.update({ "system.resource.value": clamp((res.value ?? 0) + delta, 0, max) });
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
 * split by the Major and Severe boundary values. Each zone is tappable — it marks
 * the HP that incoming damage in that band costs (Minor 1 / Major 2 / Severe 3).
 * `resource: "hitPoints"` + per-segment `mark` tell the shell to fire an
 * adjustResource intent; the adapter's invoke clamps and writes (HP `value` is the
 * marked count, so marking damage is a positive delta).
 */
function thresholdsScale(actor) {
  const t = actor.system?.damageThresholds;
  if (!t) return null;
  const major = num(t.major);
  const severe = num(t.severe);
  if (major == null && severe == null) return null;
  const markSub = (n) => game.i18n.format("MOBILE_SHEET.daggerheart.threshold.mark", { n });
  return {
    kind: "scale",
    label: L("heading.thresholds"),
    resource: "hitPoints",
    segments: [
      { label: L("threshold.minor"), sub: markSub(1), mark: 1 },
      { label: L("threshold.major"), sub: markSub(2), mark: 2 },
      { label: L("threshold.severe"), sub: markSub(3), mark: 3 }
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

/** Normalize an item's embedded actions (Collection | array) to a flat list — an alias
 *  of the act half's `actionsOf` so both read the same `actionsList ?? actions` shape
 *  (weapon.mjs prepends the attack action onto `actionsList`). */
function actionList(item) {
  return actionsOf(item);
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
  // Tapping a card opens its detail panel (use:false → openable), like a feature row.
  // The card's own spend/roll actions stay reachable as inline quick-select buttons + in the panel.
  const row = { itemId: item.id, name: item.name, img: item.img, glyph: "✦", sub, use: false };
  const recall = num(item.system?.recallCost ?? item.system?.recall);
  if (typeof recall === "number" && recall > 0) { row.cost = `↺${recall}`; row.costMuted = true; }
  attachActions(row, item);
  attachResource(row, item);
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
  const sys = w.system ?? {};
  const trait = traitLabel(sys.attack?.roll?.trait ?? sys.trait);
  const range = rangeLabel(sys.attack?.range ?? sys.range);
  const damage = weaponDamage(w);
  const row = {
    itemId: w.id, name: w.name, img: w.img, glyph: "⚔",
    sub: [trait, range].filter(Boolean).join(" · "),
    // Tap opens the detail panel (like a feature); attack/equip live in the panel + inline buttons.
    use: false
  };
  if (damage) row.badge = damage.formula;
  attachActions(row, w);
  row.controls = [{ kind: "equip", active: !!w.system?.equipped }, ...chatControl(w), { kind: "delete" }];
  return row;
}

function armorRow(a) {
  const score = num(a.system?.armor?.max ?? a.system?.baseScore ?? a.system?.score);
  const row = { itemId: a.id, name: a.name, img: a.img, glyph: "🛡", use: false };
  if (score != null) row.badge = String(score);
  attachActions(row, a);
  row.controls = [{ kind: "equip", active: !!a.system?.equipped }, ...chatControl(a), { kind: "delete" }];
  return row;
}

function stuffRow(i) {
  const qty = num(i.system?.quantity);
  const row = {
    itemId: i.id, name: i.name, img: i.img, glyph: "◈",
    sub: "",
    hasQty: true, qty: qty ?? 0,
    // Tap opens the detail panel (like a feature); use/chat live in the panel + inline buttons.
    use: false
  };
  attachActions(row, i);
  row.controls = [...chatControl(i), { kind: "delete" }];
  return row;
}

function featureRow(item) {
  // Tapping a feature row opens its detail panel (use:false → shell's `openable` path);
  // an active feature's own actions stay reachable as inline action buttons + in the panel.
  const row = { itemId: item.id, name: item.name, img: item.img, use: false };
  attachActions(row, item);
  attachResource(row, item);
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

  const rows = itemRows(actor, FEATURE_TYPES, featureRow);
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

/**
 * The world's currency config — a Homebrew game setting the GM can rename/toggle
 * (default denominations Coins/Handfuls/Bags/Chests, but a world may collapse it
 * to a single custom name like "Quantum"). Returns `{ title, <key>: {enabled,
 * label,…} }` or null on older versions / when unreadable. Defensive: never throws.
 */
function currencyConfig() {
  try {
    const id = CONFIG?.DH?.id ?? SYSTEM_ID;
    const key = CONFIG?.DH?.SETTINGS?.gameSettings?.Homebrew;
    if (!key) return null;
    return game.settings.get(id, key)?.currency ?? null;
  } catch (_) {
    return null;
  }
}

/**
 * Gold as a tile per ENABLED currency denomination, read from the world config so
 * a renamed/single currency ("Quantum") shows correctly. Falls back to the static
 * Handfuls/Bags/Chests labels if the config can't be read.
 */
function goldBlocks(actor) {
  const gold = actor.system?.gold;
  if (!gold || typeof gold !== "object") return [];

  const cfg = currencyConfig();
  let title = L("heading.gold");
  let denoms;
  if (cfg) {
    const { title: cfgTitle, ...rest } = cfg;
    if (cfgTitle) title = cfgTitle;
    denoms = Object.entries(rest)
      .filter(([, d]) => d && d.enabled !== false)
      .map(([key, d]) => ({ key, label: d.label ?? key }));
  } else {
    denoms = ["coins", "handfuls", "bags", "chests"].map((key) => ({ key, label: L(`gold.${key}`) }));
  }

  const stats = denoms
    .filter((d) => gold[d.key] != null)
    .map((d) => ({ label: d.label, value: gold[d.key] ?? 0 }));
  if (!stats.length) return [];
  return [
    { kind: "heading", label: title },
    { kind: "statGrid", cols: Math.min(stats.length, 3), stats }
  ];
}

/** Inventory: gold, then the system's inventory categories with equip controls. */
function itemsTab(actor) {
  const blocks = [...goldBlocks(actor)];

  const sections = [
    ["weapon", weaponRow],
    ["armor", armorRow],
    ["consumable", stuffRow],
    ["loot", stuffRow]
  ];
  for (const [type, map] of sections) {
    const rows = itemRows(actor, [type], map);
    blocks.push({ kind: "heading", label: typeLabel(type), count: rows.length || null, addAction: "createItem", addItemType: type });
    if (rows.length) blocks.push({ kind: "actionList", items: rows });
  }
  return blocks;
}

function bioTab(actor) {
  const bio = actor.system?.biography ?? {};
  // DH 2.x stores biography as a SchemaField of HTML fields (background / connections).
  // getViewModel is sync/pure → cannot enrich (async); hand each RAW with the actor uuid
  // and the shell enriches at render (formatting / rolls / links).
  const sections = [
    { title: L("heading.background"), html: bio.background },
    { title: L("heading.connections"), html: bio.connections }
  ];
  return sections
    .filter((s) => typeof s.html === "string" && s.html.trim())
    .map((s) => ({ kind: "info", title: s.title, html: s.html, enrich: true, relativeToUuid: actor.uuid }));
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
  const level = num(actor.system?.levelData?.level?.current ?? actor.system?.level);

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
  if (prof != null) out.push({ label: L("stat.proficiency"), value: String(prof), accent: true });
  return out;
}

/**
 * Armor is the odd resource: `system.resources.armor` is a non-persisted mirror of
 * `system.armorScore`, and marks live on the equipped armor item(s). The system never
 * writes `resources.armor.value` directly — it distributes a signed change across armor
 * sources via `system.updateArmorValue` (what toggleArmor does). So armor edits route
 * through that, by delta, or they silently no-op.
 */
function adjustArmor(actor, delta) {
  if (!delta || typeof actor.system?.updateArmorValue !== "function") return;
  return actor.system.updateArmorValue({ value: delta });
}

function writeResource(actor, key, next) {
  if (key === "armor") return adjustArmor(actor, next - (actor.system?.armorScore?.value ?? 0));
  const res = actor.system?.resources?.[key];
  if (!res) return;
  const clamped = clamp(next, 0, resolveMax(key, res));
  return actor.update({ [`system.resources.${key}.value`]: clamped });
}

function adjustResource(actor, key, delta) {
  if (key === "armor") return adjustArmor(actor, delta);
  const res = actor.system?.resources?.[key];
  if (!res) return;
  return writeResource(actor, key, (res.value ?? 0) + delta);
}

/** Keys the Vitals tab renders explicitly; anything else under `system.resources` is a
 *  module/homebrew resource the system surfaces via its resource manager. */
const BASE_RESOURCE_KEYS = new Set(["hitPoints", "stress", "hope", "armor"]);

/** Custom/homebrew actor resources (CONFIG.DH.RESOURCE.character.custom → system.resources):
 *  the parity for the default sheet's resource-manager dropdown. Empty in a vanilla world. */
function extraResourceBlocks(actor) {
  const res = actor.system?.resources ?? {};
  const out = [];
  for (const [key, r] of Object.entries(res)) {
    if (BASE_RESOURCE_KEYS.has(key) || !r || typeof r !== "object") continue;
    const max = typeof r.max === "number" ? r.max : null;
    out.push({
      kind: "resource",
      key,
      label: r.label ? game.i18n.localize(r.label) : key,
      tone: "info",
      display: max && max > 0 ? "pips" : "bar",
      value: r.value ?? 0,
      max,
      editable: true
    });
  }
  return out;
}

/**
 * Toggle equipped. Armor is exclusive (only one worn) — unequip the other first.
 * Weapons follow the system's slot rules (character.mjs #toggleEquipItem): an active
 * beastform effect blocks equipping a weapon entirely; otherwise
 * `DhCharacter.unequipBeforeEquip` (a public static, module/data/actor/character.mjs:711)
 * unequips whatever the new weapon's slot/burden would conflict with. Feature-detected —
 * older system versions without it keep today's naive single-slot behavior.
 */
async function toggleEquip(actor, itemId) {
  const item = actor.items?.get(itemId);
  if (!item) return;
  if (item.system?.equipped) return item.update({ "system.equipped": false });
  if (item.type === "armor") {
    const worn = actor.items.find((i) => i.type === "armor" && i.system?.equipped && i.id !== item.id);
    if (worn) await worn.update({ "system.equipped": false });
  } else if (item.type === "weapon") {
    if (actor.effects?.find?.((e) => !e.disabled && e.type === "beastform")) {
      ui.notifications?.warn(game.i18n.localize("DAGGERHEART.UI.Notifications.beastformEquipWeapon"));
      return;
    }
    const unequip = actor.system?.constructor?.unequipBeforeEquip;
    if (typeof unequip === "function") await unequip.call(actor.system, item);
  }
  return item.update({ "system.equipped": true });
}

/** Post an item to chat via the system's own card builder. */
function postToChat(actor, itemId) {
  const item = actor.items?.get(itemId);
  return can(item, "toChat") ? item.toChat(item.uuid) : undefined;
}

/**
 * Move a domain card between loadout and vault (the row's vault-control icon).
 * Mirrors character.mjs #toggleVault: unvaulting is cap-checked against
 * `loadoutSlot.available`, unless the card opts out via `system.loadoutIgnore`.
 * Vaulting (loadout -> vault) is always free. `available` undefined (older
 * versions without the getter) skips the check, same as today's behavior.
 */
function toggleVault(actor, itemId) {
  const item = actor.items?.get(itemId);
  if (!item) return;
  const inVault = !!item.system?.inVault;
  if (inVault) {
    const available = actor.system?.loadoutSlot?.available;
    if (available === false && !item.system?.loadoutIgnore) {
      ui.notifications?.warn(game.i18n.localize("DAGGERHEART.UI.Notifications.loadoutMaxReached"));
      return;
    }
  }
  return item.update({ "system.inVault": !inVault });
}

/**
 * Recall a vaulted domain card — the detail panel's "Recall" action. PORTED from the
 * recall context-menu handler (character.mjs, sheet-private, not callable): cap-check
 * against `loadoutSlot.available` (same rule as "To Loadout"), then, when the card has
 * a Stress cost, pay it via the system's own transient effect-type action exactly as
 * the system builds it — `action.use(event)` pops the system's own cost-confirm dialog,
 * so cancelling leaves the card vaulted and no Stress is spent. Falls back to a plain
 * unvault when the action-type API is absent (older system versions) or the cost is 0.
 */
async function recallCard(actor, itemId, event) {
  const item = actor.items?.get(itemId);
  if (!item) return;

  const available = actor.system?.loadoutSlot?.available;
  if (available === false) {
    ui.notifications?.warn(game.i18n.localize("DAGGERHEART.UI.Notifications.loadoutMaxReached"));
    return;
  }

  const recallCost = num(item.system?.recallCost ?? item.system?.recall) ?? 0;
  if (recallCost <= 0) return item.update({ "system.inVault": false });

  const cls = game.system?.api?.models?.actions?.actionsTypes?.effect;
  if (typeof cls !== "function" || typeof cls.getSourceConfig !== "function") {
    return item.update({ "system.inVault": false }); // no action-type API on this version → plain unvault
  }
  const action = new cls(
    { ...cls.getSourceConfig(item.system), type: "effect", chatDisplay: false, cost: [{ key: "stress", value: recallCost }] },
    { parent: item.system }
  );
  const config = await action.use(event);
  if (config) return item.update({ "system.inVault": false });
}

/** An item's embedded actions as a flat array (Collection | array), like Item#use reads.
 *  Shared by the read half's `actionList` so inline action buttons and the desktop-popup
 *  inspector see the same list (weapon.mjs prepends the attack onto `actionsList`). */
function actionsOf(item) {
  const a = item?.system?.actionsList ?? item?.system?.actions;
  if (!a) return [];
  if (Array.isArray(a)) return a;
  if (typeof a.values === "function") return [...a.values()];
  if (Array.isArray(a.contents)) return a.contents;
  return [];
}

/** Localized resource label for a cost key (Hope/Stress/Armor/HP/Fear), via the system config. */
function costLabel(key) {
  const cfg = CONFIG?.DH?.GENERAL?.abilityCosts?.[key];
  return cfg?.label ? game.i18n.localize(cfg.label) : key;
}

/** An action's costs, normalized for the spend sheet (label + scalable stepper bounds). */
function describeCosts(actor, action) {
  const raw = action?.cost;
  const list = Array.isArray(raw) ? raw : raw?.contents ?? [...(raw?.values?.() ?? [])];
  const item = action?.parent?.parent ?? null;
  return (list ?? [])
    .filter((c) => c && c.key)
    .map((c) => ({
      key: c.key,
      label: costLabel(c.key),
      value: c.value ?? 0,
      step: c.step ?? 1,
      scalable: !!c.scalable,
      max: parseItemFormula(c.max, actor, item)
    }));
}

/** Map an action's stored advantage state to the shell's tri-toggle default. */
function advChoice(advState) {
  if (advState === "advantage") return "advantage";
  if (advState === "disadvantage") return "disadvantage";
  return "neutral";
}

/** One resolved action → the bottom sheet the shell should open before using it. */
function describeAction(actor, action) {
  if (!action) return { kind: "direct" };
  if (action.hasRoll) {
    return {
      kind: "duality",
      uuid: action.uuid,
      title: action.name ?? "",
      advantage: advChoice(action.roll?.advState),
      ...rollOptions(actor) // experiences, hope, bonus, reaction, bonusEffects
    };
  }
  const costs = describeCosts(actor, action);
  const uses = action.uses?.max ? { value: action.uses?.value ?? 0, max: action.uses.max } : null;
  if (costs.length || uses) {
    return { kind: "spend", uuid: action.uuid, title: action.name ?? "", costs, uses };
  }
  return { kind: "direct", uuid: action.uuid };
}

/**
 * PURE-ish (reads documents, never writes): inspect what desktop popup an item/action
 * use WOULD raise, so the shell can open a pocket sheet instead. Returns one of:
 *   - { kind:"pick", actions } when an item has >1 action (the action chooser),
 *   - { kind:"duality", uuid, …rollOptions } when the action has a roll,
 *   - { kind:"spend", uuid, costs, uses } for a resource-spending action,
 *   - { kind:"direct", uuid? } when nothing needs configuring (just use it).
 * `ref` is { itemId } (a row), { uuid } (a specific action), or { trait } (a trait roll).
 */
async function getActionConfig(actor, ref = {}) {
  if (ref.trait) {
    return { kind: "duality", trait: ref.trait, advantage: "neutral", ...rollOptions(actor) };
  }
  if (ref.uuid) {
    const action = await fromUuid(ref.uuid);
    return describeAction(actor, action);
  }
  const item = actor?.items?.get(ref.itemId);
  if (!item) return { kind: "direct" };
  const actions = actionsOf(item);
  if (actions.length > 1) {
    return { kind: "pick", actions: actions.map((a) => ({ uuid: a.uuid, name: a.name ?? "", icon: a.typeIcon })) };
  }
  return describeAction(actor, actions[0]);
}

/**
 * Use an action with the player's pocket-sheets-daggerheart choices injected, suppressing every
 * desktop popup. The only seam is the synchronous `preUseAction` hook (fired after the
 * config's roll/dialog are built, before the workflow) — so all choices are decided up
 * front in the bottom sheet and applied here. A reaction generates no Fear; experiences
 * add their modifier + a Hope cost; deselected bonus effects are dropped; a scalable
 * cost's scale is set. The roll dialog is killed with `dialog.configure=false`; the
 * action-picker / spend dialog with a synthetic `shiftKey` event.
 */
async function usePocketAction(actor, action, intent) {
  const isSpend = !!intent.spend;
  const marker = foundry.utils.randomID();
  const exps = (intent.experiences ?? []).filter((id) => actor.system?.experiences?.[id]);
  const bonusOff = intent.bonusOff ?? [];

  const preId = Hooks.on(`${SYSTEM_ID}.preUseAction`, (act, config) => {
    if (act?.uuid !== action.uuid) return;
    config.__pocketMarker = marker;
    config.dialog = { ...(config.dialog ?? {}), configure: false };

    // `UsesField.execute` (the workflow step that actually spends a charge) gates on
    // `config.uses.enabled` — a flag CostField's own prepareConfig defaults to `true`,
    // but UsesField never does; it's only ever set by the desktop confirm dialog we're
    // suppressing here. Without it, a uses-only feature (no roll, no cost) silently
    // never consumes its charge — no error, the dialog just never ran to set the flag.
    if (config.uses) config.uses.enabled ??= true;

    if (config.roll) {
      const adv = advantageValue(intent.advantage);
      if (adv != null) config.roll.advantage = adv;
    }
    if (intent.reaction) config.actionType = "reaction";

    // Situational bonus → the system's free-text extra roll formula (e.g. "1d6 + 2").
    const bonus = typeof intent.bonus === "string" ? intent.bonus.trim() : "";
    if (bonus) config.extraFormula = bonus;

    if (exps.length) {
      config.experiences = [...(config.experiences ?? []), ...exps];
      const costKey = actor.isNPC ? "fear" : "hope";
      // `total` is set too: the system merges same-key costs by `total` (getRealCosts),
      // so an action that already costs Hope would otherwise add `undefined` → NaN.
      config.costs = [
        ...(config.costs ?? []),
        ...exps.map((id) => ({ extKey: id, key: costKey, value: 1, total: 1, enabled: true, name: actor.system?.experiences?.[id]?.name }))
      ];
    }

    if (intent.scale && config.costs?.length) {
      for (const cost of config.costs) {
        const n = intent.scale[cost.key];
        if (typeof n === "number" && cost.scalable) {
          cost.scale = n;
          cost.total = (cost.value ?? 0) + n * (cost.step ?? 1);
        }
      }
    }

    config.__pocketBonusOff = bonusOff;
    Hooks.off(`${SYSTEM_ID}.preUseAction`, preId);
  });
  const postId = armBonusOffByMarker(marker);

  const event = isSpend
    ? { shiftKey: true, preventDefault() {}, stopPropagation() {} }
    : intent.event ?? {};

  try {
    return await action.use(event);
  } finally {
    Hooks.off(`${SYSTEM_ID}.preUseAction`, preId);
    if (postId) Hooks.off(`${SYSTEM_ID}.postRollConfiguration`, postId);
  }
}

/** Like armBonusOff, but reads the opt-out ids stashed on the config by usePocketAction. */
function armBonusOffByMarker(marker) {
  const id = Hooks.on(`${SYSTEM_ID}.postRollConfiguration`, (roll, config) => {
    if (config?.__pocketMarker !== marker) return;
    const be = roll?.options?.bonusEffects;
    const off = config.__pocketBonusOff ?? [];
    if (be) for (const eid of off) if (be[eid]) be[eid].selected = false;
    Hooks.off(`${SYSTEM_ID}.postRollConfiguration`, id);
  });
  return id;
}

/**
 * Use an item or one of its actions. When the intent carries an action uuid we drive
 * the system's own action with the pocket choices injected (popups suppressed); a bare
 * itemId with no choices is a plain single-action use.
 */
async function useItem(actor, intent) {
  if (intent.uuid) {
    const action = await fromUuid(intent.uuid);
    if (!can(action, "use")) return;
    return usePocketAction(actor, action, intent);
  }
  return actor.items?.get(intent.itemId)?.use?.(intent.event);
}

/** Open the system's Downtime (rest) dialog — the desktop fallback when the pocket
 *  rest sheet can't be built (e.g. the move config is unreadable). */
function openRest(actor, key) {
  const Downtime = game.system?.api?.applications?.dialogs?.Downtime;
  if (!Downtime) return;
  return new Downtime(actor, key === "short").render({ force: true });
}

// --- rest (pocket Downtime) --------------------------------------------------
//
// The system's Downtime is a desktop ApplicationV2. Pocket Sheets — Daggerheart replaces it with a
// bottom sheet: pick the rest's moves (gated by the same per-category budget), then
// replicate `DhpDowntime.takeDowntime` — post the system's own downtime chat card and
// reset the same refreshables. The card's action buttons (heal, clear stress…) are the
// system's; we never apply those effects ourselves. Ported from daggerheart 2.x.

/** The world's rest-move config (Homebrew `restMoves`), deep-cloned. Null if unreadable. */
function restMovesConfig() {
  try {
    const id = CONFIG?.DH?.id ?? SYSTEM_ID;
    const key = CONFIG?.DH?.SETTINGS?.gameSettings?.Homebrew;
    if (!key) return null;
    const moves = game.settings.get(id, key)?.restMoves;
    return moves ? foundry.utils.deepClone(moves) : null;
  } catch (_) {
    return null;
  }
}

/** Per-category move budget for a short/long rest (mirrors DhpDowntime's constructor). */
function restChoiceMax(actor, moveData, shortrest) {
  const bonus = actor.system?.bonuses?.rest?.[shortrest ? "shortRest" : "longRest"] ?? {};
  return {
    shortRest: (shortrest ? moveData?.shortRest?.nrChoices ?? 0 : 0) + (bonus.shortMoves ?? 0),
    longRest: (!shortrest ? moveData?.longRest?.nrChoices ?? 0 : 0) + (bonus.longMoves ?? 0)
  };
}

/** Whether a uses/resource recovery type refreshes on the given rest (system rule). */
function refreshIsAllowed(allowedTypes, typeToCheck) {
  const rt = CONFIG?.DH?.GENERAL?.refreshTypes;
  if (!rt || !typeToCheck) return false;
  switch (typeToCheck) {
    case rt.scene?.id:
    case rt.session?.id:
    case rt.longRest?.id:
      return allowedTypes.includes(typeToCheck);
    case rt.shortRest?.id:
      return allowedTypes.some((x) => x === rt.shortRest?.id || x === rt.longRest?.id);
    default:
      return false;
  }
}

/** Item action-uses and item resources this rest refreshes (ports DhpDowntime.getRefreshables). */
function restRefreshables(actor, shortrest) {
  const allowed = [shortrest ? "shortRest" : "longRest"];
  const actionItems = [];
  const resourceItems = [];
  for (const item of actor.items ?? []) {
    let available = true;
    try { available = actor.system?.isItemAvailable ? actor.system.isItemAvailable(item) : true; } catch (_) { available = true; }
    const acts = item.system?.actions;
    if (available && acts) {
      const list = Array.isArray(acts) ? acts : [...(acts?.values?.() ?? Object.values(acts))];
      for (const action of list) {
        if (action?.uses?.recovery && refreshIsAllowed(allowed, action.uses.recovery)) {
          actionItems.push({ title: item.name, name: action.name, uuid: action.uuid });
        }
      }
    }
    const resource = item.system?.resource;
    if (resource?.type && refreshIsAllowed(allowed, resource.recovery)) {
      resourceItems.push({ title: game.i18n.localize(`TYPES.Item.${item.type}`), name: item.name, uuid: item.uuid });
    }
  }
  return { actionItems, resourceItems };
}

/**
 * Delete "until your next rest" active effects once a rest's full budget is taken —
 * PORTED from expireActiveEffects (module/helpers/utils.mjs:476), sheet/system-private
 * (not exposed on game.system.api). Gated on the Automation setting
 * `autoExpireActiveEffects` (a no-op when off, so GM settings stay respected); an
 * effect's `system.duration.type` is matched against `activeEffectDurations`, skipping
 * `temporary`/`custom`, always expiring `act`-duration effects, and expiring
 * shortRest/longRest-duration effects via the same `refreshIsAllowed` rule the
 * refreshables loop uses. Any config read failing → skip expiry silently (older
 * versions had no such setting either).
 */
async function expireRestActiveEffects(actor, shortrest) {
  try {
    const id = CONFIG?.DH?.id ?? SYSTEM_ID;
    const key = CONFIG?.DH?.SETTINGS?.gameSettings?.Automation;
    if (!key) return;
    const auto = game.settings.get(id, key)?.autoExpireActiveEffects;
    if (!auto) return;

    const durations = CONFIG?.DH?.GENERAL?.activeEffectDurations;
    if (!durations) return;
    const allowed = [shortrest ? "shortRest" : "longRest"];
    const effects = typeof actor.getActiveEffects === "function" ? actor.getActiveEffects() : [...(actor.effects ?? [])];

    const toExpire = effects
      .filter((effect) => {
        const type = effect?.system?.duration?.type;
        if (!type) return false;
        if (type === durations.temporary?.id || type === durations.custom?.id) return false;
        if (type === durations.act?.id) return true;
        return refreshIsAllowed(allowed, type);
      })
      .map((e) => e.id);

    if (toExpire.length) await actor.deleteEmbeddedDocuments("ActiveEffect", toExpire);
  } catch (_) {
    // config unreadable → skip expiry silently
  }
}

/**
 * PURE-ish (reads settings/items, never writes): what the pocket rest sheet needs —
 * the move categories in budget for this rest, each with its pickable moves. Null when
 * the system has no Downtime or the move config can't be read → the shell falls back to
 * the system's desktop dialog.
 */
function getRestConfig(actor, key) {
  if (!game.system?.api?.applications?.dialogs?.Downtime) return null;
  const moveData = restMovesConfig();
  if (!moveData) return null;
  const shortrest = key === "short";
  const max = restChoiceMax(actor, moveData, shortrest);
  const categories = ["shortRest", "longRest"]
    .filter((cat) => (max[cat] ?? 0) > 0)
    .map((cat) => ({
      key: cat,
      max: max[cat],
      moves: Object.entries(moveData[cat]?.moves ?? {}).map(([mkey, m]) => ({
        key: mkey,
        name: m.name ?? mkey,
        icon: m.icon ?? "",
        img: m.img ?? "",
        desc: m.description ?? ""
      }))
    }))
    .filter((c) => c.moves.length);
  if (!categories.length) return null;
  const title = game.i18n.localize(`DAGGERHEART.APPLICATIONS.Downtime.${shortrest ? "shortRest" : "longRest"}.title`);
  return { title, key, categories };
}

/** Total moves selected in one category's picks. */
function sumPicks(sel) {
  return Object.values(sel ?? {}).reduce((a, n) => a + (Number(n) || 0), 0);
}

/**
 * Apply a pocket rest: post the system's downtime chat card for the picked moves and
 * reset the rest's refreshables when the full budget was taken — a faithful port of
 * DhpDowntime.takeDowntime. `picks` is `{ [category]: { [moveKey]: count } }`.
 */
async function applyRest(actor, key, picks) {
  const moveData = restMovesConfig();
  if (!moveData) return openRest(actor, key); // can't read config → desktop dialog
  const shortrest = key === "short";

  for (const [cat, sel] of Object.entries(picks ?? {})) {
    for (const [mkey, count] of Object.entries(sel ?? {})) {
      if (moveData[cat]?.moves?.[mkey] && count > 0) moveData[cat].moves[mkey].selected = count;
    }
  }

  const moves = Object.keys(moveData).flatMap((categoryKey) => {
    const category = moveData[categoryKey];
    return Object.keys(category?.moves ?? {})
      .filter((x) => category.moves[x].selected)
      .flatMap((mk) => {
        const move = category.moves[mk];
        const acts = move.actions;
        const list = Array.isArray(acts) ? acts : [...(acts?.values?.() ?? Object.values(acts ?? {}))];
        const needsTarget = list.some((a) => a?.target?.type && a.target.type !== "self");
        return [...Array(move.selected).keys()].map(() => ({ ...move, movePath: `${categoryKey}.moves.${mk}`, needsTarget }));
      });
  });
  if (!moves.length) return;

  const characters = (game.actors ?? []).filter(
    (a) => a.type === "character" && a.testUserPermission(game.user, "LIMITED") && a.uuid !== actor.uuid
  );

  const cls = getDocumentClass("ChatMessage");
  const title = game.i18n.localize(`DAGGERHEART.APPLICATIONS.Downtime.${shortrest ? "shortRest" : "longRest"}.title`);
  const content = await foundry.applications.handlebars.renderTemplate(
    "systems/daggerheart/templates/ui/chat/downtime.hbs",
    { title, actor: { name: actor.name, img: actor.img }, moves, characters, selfId: actor.uuid }
  );
  await cls.create({
    user: game.user.id,
    system: { moves, actor: actor.uuid },
    speaker: cls.getSpeaker({ actor }),
    title,
    content,
    flags: { daggerheart: { cssClass: "dh-chat-message dh-style" } }
  });

  // Reset refreshables once the full budget is taken (mirrors takeDowntime's gate).
  const max = restChoiceMax(actor, moveData, shortrest);
  const taken = { shortRest: sumPicks(picks?.shortRest), longRest: sumPicks(picks?.longRest) };
  if (taken.shortRest >= max.shortRest && taken.longRest >= max.longRest) {
    const refreshables = restRefreshables(actor, shortrest);
    for (const data of refreshables.actionItems) {
      const action = await fromUuid(data.uuid);
      if (action?.parent?.parent && action.id != null) {
        await action.parent.parent.update({ [`system.actions.${action.id}.uses.value`]: 0 });
      }
    }
    for (const data of refreshables.resourceItems) {
      const feature = await fromUuid(data.uuid);
      const res = feature?.system?.resource;
      if (!res) continue;
      const increasing = res.progression === CONFIG?.DH?.ITEM?.itemResourceProgression?.increasing?.id;
      // takeDowntime evaluates the formula (new Roll(...).evaluateSync().total), not the bare
      // replaced string — writing the string into a NumberField is a validation error / NaN.
      // Reuses the R6 formula helper (parseItemFormula), which already mirrors this evaluation.
      const resetValue = increasing ? 0 : res.max ? parseItemFormula(res.max, actor, feature) ?? 0 : 0;
      await feature.update({ "system.resource.value": resetValue });
    }

    await expireRestActiveEffects(actor, shortrest);
  }
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
async function rollTraitDirect(actor, intent) {
  if (typeof actor.rollTrait !== "function") return;
  const roll = { trait: intent.key, type: "trait" };
  const adv = advantageValue(intent.advantage);
  if (adv != null) roll.advantage = adv;
  if (intent.difficulty != null && !Number.isNaN(Number(intent.difficulty))) {
    roll.difficulty = Number(intent.difficulty);
  }

  const options = { dialog: { configure: false }, roll, event: intent.event };

  // Experiences applied to the roll: each adds its modifier (the system reads
  // `config.experiences` in D20Roll.configureModifiers) and costs 1 Hope (Fear for
  // NPCs). The system's own roll dialog is where that pairing normally happens; we
  // skip the dialog, so we mirror its config — selected ids + matching costs — by hand.
  const exps = (intent.experiences ?? []).filter((id) => actor.system?.experiences?.[id]);
  if (exps.length) {
    options.experiences = exps;
    const costKey = actor.isNPC ? "fear" : "hope";
    options.costs = exps.map((id) => ({
      extKey: id,
      key: costKey,
      value: 1,
      total: 1,
      enabled: true,
      name: actor.system?.experiences?.[id]?.name
    }));
  }

  // Situational bonus → the system's free-text extra roll formula (e.g. "1d6 + 2").
  const bonus = typeof intent.bonus === "string" ? intent.bonus.trim() : "";
  if (bonus) options.extraFormula = bonus;

  // Reaction roll → no Fear generated (DualityRoll.addDualityResourceUpdates skips it).
  if (intent.reaction) options.actionType = "reaction";

  // Bonus effects the player opted out of for this roll, applied after the Roll is
  // built (its bonusEffects list is constructed there) via the postRollConfiguration hook.
  const marker = foundry.utils.randomID();
  options.__pocketMarker = marker;
  const hookId = armBonusOff(marker, intent.bonusOff);
  try {
    const config = await actor.rollTrait(intent.key, options);
    await applyRollResources(config);
    return config;
  } finally {
    if (hookId) Hooks.off(`${SYSTEM_ID}.postRollConfiguration`, hookId);
  }
}

/**
 * Apply per-roll bonus-effect opt-outs without the system dialog. The applicable
 * effects are built inside the Roll constructor, so we wait for the (sync)
 * `postRollConfiguration` hook — fired after build, before evaluate — and flip the
 * matching `roll.options.bonusEffects[id].selected` off. Scoped to OUR roll via a
 * unique marker on the config; self-removing. Returns the hook id (or null) so the
 * caller can also tear it down if the roll never fires.
 */
function armBonusOff(marker, bonusOff) {
  if (!bonusOff?.length) return null;
  const id = Hooks.on(`${SYSTEM_ID}.postRollConfiguration`, (roll, config) => {
    if (config?.__pocketMarker !== marker) return;
    const be = roll?.options?.bonusEffects;
    if (be) for (const eid of bonusOff) if (be[eid]) be[eid].selected = false;
    Hooks.off(`${SYSTEM_ID}.postRollConfiguration`, id);
  });
  return id;
}

/**
 * Apply a finished roll's resource changes. A DH roll *builds* its resource updates
 * (Hope-on-Hope, Fear-on-Fear automation) and our experience costs into
 * `config.resourceUpdates`/`config.costs`, but never *writes* them — the system's own
 * sheet does that after the roll returns (DhCharacter #rollAttribute). We mirror that
 * so automation and the Hope spend actually land. No-op when automation is off (the
 * map stays empty) so the GM's settings are respected.
 */
async function applyRollResources(config) {
  if (!config?.resourceUpdates) return;
  const costs = (config.costs ?? []).filter((c) => c.enabled !== false);
  if (costs.length) {
    config.resourceUpdates.addResources(costs.map((c) => ({ ...c, value: -c.value })));
  }
  await config.resourceUpdates.updateResources();
}

/**
 * Active effects on the actor that grant a roll bonus, surfaced as toggleable chips
 * (default on) so a player can opt one out for a single roll — the mobile stand-in
 * for the desktop dialog's bonus-effect list. APPROXIMATE: the system computes the
 * exact applicable set inside the Roll constructor, which we can't run before the
 * roll fires; we match enabled effects whose changes target a `system.bonuses.roll.*`
 * key. The apply step keys off the real `roll.options.bonusEffects` by id, so an id
 * that isn't actually applicable simply no-ops. PURE.
 */
function bonusEffectChoices(actor) {
  const out = [];
  let effects = [];
  try {
    effects = actor.appliedEffects ?? [...(actor.allApplicableEffects?.() ?? [])];
  } catch (_) {
    effects = [];
  }
  for (const eff of effects ?? []) {
    if (!eff || eff.disabled || eff.isSuppressed) continue;
    const changes = eff.system?.changes ?? eff.changes ?? [];
    if (changes.some((c) => typeof c?.key === "string" && c.key.includes("system.bonuses.roll."))) {
      out.push({ id: eff.id, name: eff.name ?? "" });
    }
  }
  return out;
}

/**
 * Roll-sheet augmentations the shell renders in the duality roll bottom sheet:
 * the actor's experiences (tap to apply: +value, −1 Hope each), current spendable
 * Hope to gate them, a situational flat bonus stepper, a reaction toggle, and any
 * opt-out bonus effects. PURE.
 */
function rollOptions(actor) {
  const exp = actor.system?.experiences ?? {};
  const experiences = Object.entries(exp).map(([key, e]) => ({
    key,
    name: e?.name ?? "",
    value: typeof e?.value === "number" ? e.value : 0
  }));
  const hope = actor.system?.resources?.hope;
  return {
    bonus: true,
    reaction: true,
    experiences,
    bonusEffects: bonusEffectChoices(actor),
    hope: hope ? { value: hope.value ?? 0, max: resolveMax("hope", hope) } : null
  };
}

/**
 * Normalize a finished roll's config into a banner-ready result, or null when the
 * action had no roll (a spend / direct use). After a roll, the system reassigns
 * `config.roll` to its postEvaluate data (DualityRoll.postEvaluate): grand `total`,
 * `isCritical`, `hope`/`fear` die values, and `result.{duality, label}` (label already
 * localized: Hope / Fear / Critical Success). The chat log is hidden in phone
 * sheet-only mode, so the shell echoes this as a transient banner. PURE.
 */
function describeRoll(config) {
  const r = config?.roll;
  if (!r || typeof r !== "object" || typeof r.total !== "number") return null;
  const duality = r.result?.duality;
  const outcome = r.isCritical ? "crit" : duality > 0 ? "hope" : duality < 0 ? "fear" : "flat";
  const out = { total: r.total, outcome, label: r.result?.label ?? "" };
  const dice = [];
  if (r.hope?.value != null) dice.push({ label: L("banner.hope"), value: r.hope.value, tone: "accent" });
  if (r.fear?.value != null) dice.push({ label: L("banner.fear"), value: r.fear.value, tone: "stress" });
  if (dice.length) out.dice = dice;
  if (typeof r.success === "boolean") out.success = r.success;
  return out;
}

/**
 * Generic dice pool → a plain Foundry roll posted to chat. Not a Daggerheart
 * mechanic (no duality / traits) — just the core dice roller the shell's dice
 * tray opens. Returns the evaluated Roll so the shell can echo the result inline
 * (the chat log is hidden in phone sheet-only mode).
 */
async function rollDice(actor, formula) {
  if (!formula || typeof formula !== "string") return;
  const roll = await new Roll(formula).evaluate();
  await roll.toMessage({ speaker: ChatMessage.getSpeaker({ actor }) });
  return roll;
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

// --- item detail panel -------------------------------------------------------

/**
 * Description fields for an ItemDetail. getItemDetail is pure/sync so it cannot run
 * the system's async enricher; instead it hands the item's stored HTML RAW plus the
 * item uuid, and the shell enriches at render time (inline rolls / @UUID links /
 * formatting resolved relative to the item). Empty object when there's no text, so
 * spreading it adds nothing.
 */
function descFields(item) {
  const raw = item.system?.description ?? item.system?.notes;
  const html = typeof raw === "string" ? raw : raw?.value;
  if (!html || typeof html !== "string" || !html.trim()) return {};
  return { desc: html, descEnrich: true, descRelativeToUuid: item.uuid };
}

/** Drop empty/missing pairs; stringify values. */
function badges(pairs) {
  return pairs
    .filter((p) => p && p.value != null && p.value !== "")
    .map((p) => ({ label: p.label, value: String(p.value), tone: p.tone }));
}

/** Post-to-chat action, only when the item supports it. Variant set per kind. */
function chatAction(item, variant) {
  return can(item, "toChat")
    ? { label: L("detail.chat"), intent: "toChat", itemId: item.id, variant }
    : null;
}

/** Equip / Unequip action for gear. */
function equipAction(item, variant) {
  return {
    label: item.system?.equipped ? L("detail.unequip") : L("detail.equip"),
    intent: "equip",
    itemId: item.id,
    variant
  };
}

/** "Weapon · Equipped" / "Armor · Worn" — append a status suffix to the kind tag. */
function statusTag(base, suffix) {
  return suffix ? `${base} · ${suffix}` : base;
}

/**
 * PURE: one owned item → an ItemDetail panel, or null to fall back to the
 * system's desktop sheet (features, unknown types). Delegation note: "Recall
 * costs Stress", "Use heals 1d4" etc. are SYSTEM effects — we only fire the
 * intent and never assert the cost in the UI (the mock fakes those subs; we don't).
 */
function getItemDetail(actor, itemId) {
  const item = actor?.items?.get(itemId);
  if (!item) return null;
  const tag = typeLabel(item.type);
  const desc = descFields(item);
  const sys = item.system ?? {};

  // Domain card — type id varies across versions; detect by its vault flag too.
  if (item.type === "domainCard" || sys.inVault != null || sys.recallCost != null) {
    const recall = num(sys.recallCost ?? sys.recall) ?? 0;
    const inVault = !!sys.inVault;
    const domain = sys.domain ?? "";
    // The card's own actions (spend/roll) — each reuses the useItem(uuid) path so the
    // system's spend/roll popups are caught into pocket sheets, like a feature panel.
    const cardActions = actionsOf(item)
      .filter((a) => a?.uuid)
      .map((a) => ({ label: a.name ?? L("detail.use"), intent: "useItem", uuid: a.uuid, variant: "default" }));
    return {
      glyph: "✦",
      iconTone: "accent",
      tag: statusTag(typeLabel("domainCard"), domain),
      name: item.name,
      ...desc,
      badges: badges([
        { label: L("badge.domain"), value: domain, tone: "accent" },
        { label: L("badge.level"), value: num(sys.level) },
        { label: L("badge.recall"), value: recall > 0 ? `↺ ${recall}` : L("badge.free"), tone: recall > 0 ? "stress" : "info" }
      ]),
      // Loadout → card actions lead, then Chat / To Vault. Vaulted → Recall leads.
      actions: inVault
        ? [
            { label: L("detail.recall"), intent: "recall", itemId: item.id, variant: "primary" },
            ...cardActions,
            chatAction(item, "ghost")
          ].filter(Boolean)
        : [
            ...cardActions.map((a, i) => (i === 0 ? { ...a, variant: "primary" } : a)),
            chatAction(item, cardActions.length ? "ghost" : "primary"),
            { label: L("detail.toVault"), intent: "vault", itemId: item.id, variant: "default" }
          ].filter(Boolean)
    };
  }

  if (item.type === "weapon") {
    const damage = weaponDamage(item);
    return {
      glyph: "⚔",
      iconTone: "accent",
      tag: statusTag(tag, sys.equipped ? L("detail.statusEquipped") : ""),
      name: item.name,
      ...desc,
      badges: badges([
        { label: L("badge.trait"), value: traitLabel(sys.attack?.roll?.trait ?? sys.trait) },
        { label: L("badge.range"), value: rangeLabel(sys.attack?.range ?? sys.range) },
        { label: L("badge.damage"), value: damage ? [damage.formula, ...damage.types].filter(Boolean).join(" ") : "", tone: "accent" },
        { label: L("badge.burden"), value: burdenLabel(sys.burden) }
      ]),
      actions: [
        can(item, "use") ? { label: L("detail.rollAttack"), intent: "useItem", itemId: item.id, variant: "primary" } : null,
        equipAction(item, "default"),
        chatAction(item, "ghost")
      ].filter(Boolean)
    };
  }

  if (item.type === "armor") {
    const score = num(sys.armor?.max ?? sys.baseScore ?? sys.score);
    const marks = num(sys.armor?.current);
    const major = num(sys.baseThresholds?.major ?? sys.major);
    const severe = num(sys.baseThresholds?.severe ?? sys.severe);
    return {
      glyph: "🛡",
      iconTone: "armor",
      tag: statusTag(tag, sys.equipped ? L("detail.statusWorn") : ""),
      name: item.name,
      ...desc,
      badges: badges([
        { label: L("badge.score"), value: score, tone: "armor" },
        { label: L("badge.marks"), value: marks, tone: "armor" },
        { label: L("badge.major"), value: major },
        { label: L("badge.severe"), value: severe }
      ]),
      actions: [equipAction(item, "primary"), chatAction(item, "ghost")].filter(Boolean)
    };
  }

  if (item.type === "consumable" || item.type === "loot") {
    const qty = num(sys.quantity);
    const consumable = item.type === "consumable";
    return {
      glyph: "◈",
      iconTone: "info",
      tag,
      name: item.name,
      ...desc,
      badges: badges([
        { label: L("badge.type"), value: tag },
        { label: L("badge.qty"), value: typeof qty === "number" ? `× ${qty}` : "" }
      ]),
      actions: [
        consumable && can(item, "use")
          ? { label: L("detail.use"), intent: "useItem", itemId: item.id, variant: "primary" }
          : null,
        chatAction(item, consumable ? "ghost" : "primary")
      ].filter(Boolean)
    };
  }

  // Features (ancestry / community / class / subclass / feature / companion): no
  // gear stats, but a description + any embedded actions. Each action button reuses
  // the useItem(uuid) path, so the system's roll / spend popups are caught into pocket
  // sheets like an item row. Returning a panel keeps these off the desktop sheet.
  if (FEATURE_TYPES.includes(item.type)) {
    const domain = sys.domain ?? "";
    const level = num(sys.level);
    const actions = actionsOf(item)
      .filter((a) => a?.uuid)
      .map((a, i) => ({
        label: a.name ?? L("detail.use"),
        intent: "useItem",
        uuid: a.uuid,
        variant: i === 0 ? "primary" : "default"
      }));
    const chat = chatAction(item, actions.length ? "ghost" : "primary");
    if (chat) actions.push(chat);
    return {
      glyph: "✶",
      iconTone: "accent",
      tag,
      name: item.name,
      ...desc,
      badges: badges([
        { label: L("badge.domain"), value: domain, tone: "accent" },
        { label: L("badge.level"), value: level }
      ]),
      actions
    };
  }

  return null; // unknown types → desktop sheet fallback
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

  /** PURE: one owned item → an in-sheet detail panel, or null for the desktop fallback. */
  getItemDetail(actor, itemId) {
    return getItemDetail(actor, itemId);
  },

  /** Inspect which desktop popup an item/action use would raise, so the shell can
   *  open a pocket bottom sheet instead. Reads documents; never writes. */
  getActionConfig(actor, ref) {
    return getActionConfig(actor, ref);
  },

  /** What the pocket rest sheet needs (move categories + budgets), or null for the
   *  system's own Downtime dialog. Reads settings/items; never writes. */
  getRestConfig(actor, key) {
    return getRestConfig(actor, key);
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
      // Armor only when worn armor grants slots (matches the system sidebar's gate).
      actor.system?.armorScore?.max > 0 ? resourceBlock(actor, "armor", L("resource.armor"), "armor", "pips") : null,
      ...extraResourceBlocks(actor)
    ].filter(Boolean);

    vitals.push({ kind: "heading", label: L("heading.traits") }, traitsGrid(actor));
    const rest = restButtons();
    if (rest) vitals.push(rest);

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
      primary: { label: L("primary.duality"), rollOptions: rollOptions(actor) }
    };
  },

  /** Delegate each intent to the system's own method. Unknown intent → no-op. */
  async invoke(actor, intent) {
    switch (intent.type) {
      case "rollTrait":
        return describeRoll(await rollTraitDirect(actor, intent));
      case "primary":
      case "rollStat":
        // Fallback path (no roll-sheet config) → the system's own roll dialog.
        return describeRoll(await actor.rollTrait?.(intent.statKey ?? intent.key, { event: intent.event }));
      case "rollDice":
        return rollDice(actor, intent.formula);
      case "useItem":
        return describeRoll(await useItem(actor, intent));
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
      case "recall":
        return recallCard(actor, intent.itemId, intent.event);
      case "rest":
        // Picks from the pocket rest sheet → apply; bare (fallback) → desktop dialog.
        return intent.picks ? applyRest(actor, intent.key, intent.picks) : openRest(actor, intent.key);
      case "deathMove":
        return openDeathMove(actor);
      case "rollResourceDice":
        return rerollItemDice(actor, intent.itemId);
      case "toggleResourceDie":
        return toggleItemDie(actor, intent.itemId, intent.key);
      case "adjustItemResource":
        return adjustItemResource(actor, intent.itemId, intent.delta);
      case "adjustResource":
        return adjustResource(actor, intent.key, intent.delta);
      case "setResource":
        return writeResource(actor, intent.key, intent.value);
      case "toggleTag":
        return actor.toggleStatusEffect?.(intent.key);
      case "deleteItem":
        return actor.items?.get(intent.itemId)?.delete();
      case "adjustItemQty": {
        const qitem = actor.items?.get(intent.itemId);
        if (!qitem) return;
        const cur = num(qitem.system?.quantity) ?? 0;
        return qitem.update({ "system.quantity": Math.max(0, cur + intent.delta) });
      }
      case "createItem": {
        const typeName = game.i18n.localize(`TYPES.Item.${intent.itemType}`) || intent.itemType;
        const created = await Item.create({ type: intent.itemType, name: typeName }, { parent: actor });
        created?.sheet?.render(true);
        return;
      }
      default:
        return;
    }
  }
};

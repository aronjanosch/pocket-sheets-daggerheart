# Release blocker — Read-path parity with system 2.5.x

Audit basis: Foundryborne/daggerheart **v2.5.4** source (2026-07-16). Every item
below is a field the adapter reads that does not exist (or moved) in 2.5.x. All are
in `adapters/daggerheart.js`; none touch the shell. Because the system's Foundry-v13
line ships older versions, every fix **dual-reads**: try the 2.5.x path, fall back to
the legacy path the adapter uses today.

Severity legend: 🔴 feature silently dead · 🟠 visible data missing · 🟡 cosmetic.

---

## R1 🟠 Weapon stats read pre-2.x paths

`weaponRow()` (~line 325) and the weapon branch of `getItemDetail()` (~line 1352)
read `system.trait`, `system.range`, `system.damage`. In 2.5.x
(`module/data/item/weapon.mjs`) none of these exist at the top level; the weapon's
attack is an embedded action:

| Pocket reads            | 2.5.x actual                                                  |
|-------------------------|---------------------------------------------------------------|
| `system.trait`          | `system.attack.roll.trait` (id, e.g. `agility` — localize via `DAGGERHEART.CONFIG.Traits.<id>.name`) |
| `system.range`          | `system.attack.range` (id — localize via `DAGGERHEART.CONFIG.Range.<id>.name`) |
| `system.damage`         | `system.attack.damage.parts[*].value` — a `DHActionDiceData`; display formula = `part.value.getFormula()` (sync; custom formula or `<multiplier><dice> + bonus`), damage type = `part.type` array |
| `system.burden` (ok)    | unchanged, but it's an id — localize via `DAGGERHEART.CONFIG.Burden.<id>` like the system's `_getLabels` does |

Result today: weapon rows show no trait/range subtitle and no damage badge; the
detail panel's trait/range/damage badges are empty.

Fix: read `system.attack?.roll?.trait ?? system.trait` etc.; damage from the first
`hitPoints`-applying part (or first part), via `getFormula()` guarded with
`typeof part?.value?.getFormula === "function"`.

## R2 🟠 Armor score reads migrated-away field

`armorRow()` (~line 341) and the armor branch of `getItemDetail()` (~line 1375) read
`system.baseScore` / `system.score`. 2.5.x migrated this
(`module/data/item/armor.mjs` `migrateData`): score = **`system.armor.max`**, marked
slots = **`system.armor.current`**. `baseThresholds.{major,severe}` is unchanged.

Fix: `num(sys.armor?.max ?? sys.baseScore ?? sys.score)`. Optionally show
`armor.current` as marks in the detail panel (new information we currently drop).

## R3 🟡 `getChatCard` is dead code — remove it

*(Superseded 2026-07-16: Chat mode now renders every message natively via
`message.getHTML()` — commit `7734956` — which fixed the original bug: the old
parser read `message.rolls[0].hope/.fear/.result`, properties that only ever
existed on the transient roll config, so duality cards never rendered.)*

Nothing calls `adapter.getChatCard` anymore. Remove:

- `getChatCard()` + the `plainText()` helper it uses (~lines 1163–1206) and the
  `getChatCard` entry in the adapter object (~line 1477) in
  `adapters/daggerheart.js`.
- The `getChatCard` typedef entry in `scripts/contract.js` (~lines 56, 119) and the
  `ChatCard` typedef if now unreferenced.
- The stale doc comment in `scripts/sheet.js` `#chatContext` (~line 313) claiming
  the roll-card piece "is delegated to the adapter's optional `getChatCard`" —
  describe the native `getHTML()` path instead.

`describeRoll()` (the in-sheet roll banner) is a different path and stays.

## R4 🔴 Bonus-effect chips never appear

`bonusEffectChoices()` (~line 1110): `eff.changes ?? eff.system?.changes`. Core
`ActiveEffect#changes` is always an array (usually empty — Daggerheart stores its
changes in the **typed system data**, `effect.system.changes`, see
`module/data/activeEffect/baseEffect.mjs`). `??` never falls through on `[]`, so the
match always fails and the roll sheet never offers opt-out chips.

Fix: check `eff.system?.changes` **first**, then `eff.changes`; also skip
`eff.isSuppressed` (the system filters suppressed effects in
`getActionRelevantEffects`). Key match `.includes("system.bonuses.roll.")` is
correct for 2.5.x keys. The apply step (`armBonusOff`) keys off the real
`roll.options.bonusEffects` and needs no change — chips that aren't applicable
already no-op.

## R5 🟠 Identity subtitle: level never shown

`buildIdentity()` (~line 518) reads `actor.system.level`. Doesn't exist; the level
is **`system.levelData.level.current`** (see the system sheet header, which renders
`levelData.level.changed`). Fix: `num(sys.levelData?.level?.current ?? sys.level)`.

## R6 🟠 Item-resource formula parsing breaks on compound formulas

`parseItemFormula()` (~line 62) resolves `Roll.replaceFormulaData(...)` with
`Number(...)`. `Number("2 + 1")` → `NaN` → `null`, so a Prayer-Dice-style pool with
max `1 + @tier` renders zero dice, and simple counters lose their max. The system
evaluates: `new Roll(Roll.replaceFormulaData(max, rollData)).evaluateSync().total`
(`module/applications/dialogs/downtime.mjs`). `evaluateSync` is sync — legal in the
PURE read half for deterministic formulas.

Fix: after `replaceFormulaData`, if `Number()` is `NaN`, try
`new Roll(sliced).evaluateSync({ strict: false }).total` in the existing try/catch.
Also pass `actor.getRollData()` (already done ✓).

## R7 🟡 Proficiency rendered as a modifier

`topStats()` (~line 543) formats proficiency with `mod()` → shows `+2`. Proficiency
is a multiplier (number of damage dice), not an additive modifier; the system sheet
shows a plain number. Fix: `String(prof)`.

## R8 🟡 Gold fallback drops `coins`

`goldBlocks()` fallback (~line 463) lists `handfuls/bags/chests` only; 2.5.x
`system.gold` also has `coins` (schema `GoldField`, homebrew currency default
Coins/Handfuls/Bags/Chests). Only hit when the Homebrew setting is unreadable. Fix:
add `coins` (+ lang key `gold.coins`).

## R9 🟡 Scalable-cost `max` may be a formula

`describeCosts()` (~line 646): `typeof c.max === "number" ? c.max : null` → a
formula max (`@prof`) yields an unbounded stepper. The system resolves it via
`CostField.formatMax` (`Roll.replaceFormulaData` + total). Fix: reuse the R6 helper
on string maxes. The system's real bound is `maxStep = floor((max - value) / step)`
— clamp the stepper to that.

## R10 🟡 Weapon rows: attack missing from inline action buttons

`actionList()` (read half, ~line 260) reads `system.actions` only, while
`actionsOf()` (act half, ~line 627) correctly prefers `system.actionsList` — which
for weapons **prepends the attack action** (`weapon.mjs` `get actionsList`). Rows
therefore show inline buttons for secondary actions but not Attack (the detail
panel's Roll Attack works, since it goes through `item.use()`). Fix: make
`actionList()` read `actionsList ?? actions` like `actionsOf()` — or merge the two
helpers; they are duplicates apart from this.

---

## Non-issues verified in the same audit (do not "fix")

- `daggerheart.postRollConfiguration` hook still fires — `config.hooks` ends with
  `''`, producing the generic name (`dhRoll.mjs buildConfigure`).
- `applyRollResources` after `rollTrait` is still required and does **not**
  double-apply: the roll pipeline only *builds* `resourceUpdates`; the system sheet
  applies them after the fact (`character.mjs #rollAttribute`). `action.use()`
  conversely applies them itself — and `usePocketAction` correctly does not.
- Experience costs `{ key: hope|fear, value: 1, total: 1, extKey }` match the
  system dialog + `getRealCosts` merging.
- `sheetLists`, `domainCards.loadout/vault`, `updateArmorValue({value})`,
  `deathMoveViable`, `spellcastModifierTrait.key`, `damageThresholds.{major,severe}`,
  conditions `vulnerable/hidden/restrained`, `resources` shapes and defaults
  (stress max 6; hope max always set in prepared data), Homebrew
  `currency`/`restMoves` shapes, `refreshTypes` semantics, `toChat(uuid)`,
  item-resource `diceValue/die/simple` — all confirmed against 2.5.4.

## Verification

Live world on system 2.5.x: equip a weapon → row shows trait · range + damage
badge; open armor detail → score badge; make any duality roll → Chat mode shows the
compact card with hope/fear dice; add an effect changing
`system.bonuses.roll.trait.bonus` → chip appears and opting out changes the total;
character header shows "Level N"; a Prayer-Dice feature with max `1 + @tier` shows
the right pool size.

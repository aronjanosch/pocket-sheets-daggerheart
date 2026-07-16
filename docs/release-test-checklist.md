# Release test checklist — 1.0 fixes (read parity + write rules)

Manual verification of the 2026-07-16 fix batch (`1100ebf`) before promoting to the
live instance and tagging 1.0. Covers the Verification sections of
[specs/release-read-parity.md](../specs/release-read-parity.md) and
[specs/release-write-rules.md](../specs/release-write-rules.md), plus a regression
smoke pass.

## Setup

- [ ] **Test instance** (`foundryvtt-dev` on trantor) pulled to `1100ebf`, Foundry
      world on Daggerheart **2.5.x**, browser hard-reloaded (Ctrl/Cmd+Shift+R).
- [ ] One test character with: a class + subclass, a few experiences, 2+ domain
      cards (at least one with recall cost > 0), one-handed **and** two-handed
      weapons, a secondary weapon, two armors, a consumable, some gold, and a
      feature with an item resource whose max is a formula (e.g. `1 + @tier`).
- [ ] Test on a real phone **and** in forced pocket mode on desktop (toggle macro).
- [ ] System settings: Automation → Hope/Fear automation ON,
      `autoExpireActiveEffects` ON (one check below flips it OFF).

## A — Read parity (display)

- [ ] **Weapon row** (Items tab): subtitle shows localized *Trait · Range*
      (e.g. "Agility · Melee", not raw ids); damage badge shows a resolved formula
      (e.g. `2d12 + 1`, **not** `@profd12`).
- [ ] **Weapon detail panel**: Trait / Range / Damage / Burden badges all filled,
      Burden localized (e.g. "One-Handed").
- [ ] **Armor row + detail**: Score badge shows the armor score; detail also shows
      Marks and Major/Severe thresholds.
- [ ] **Identity header**: subtitle shows "Level N · Class · Subclass".
- [ ] **Top stats**: Proficiency shows plain `2`, not `+2`; Evasion unchanged.
- [ ] **Gold**: tiles match the world's Homebrew currency config (rename a
      denomination in settings and re-open the sheet to confirm it follows).
- [ ] **Item resource with formula max** (`1 + @tier` etc.): pool/counter renders
      the correct size, stepper clamps at the evaluated max.
- [ ] **Weapon inline buttons**: the attack action appears as an inline quick
      button on the weapon row (not just extra actions).

## B — Roll sheet

- [ ] Trait roll via pocket duality sheet: no desktop dialog appears; chat message
      + banner show Hope/Fear dice; Hope/Fear resource automation applies (Hope +1
      on Hope result, Fear +1 on Fear, Stress −1 + Hope +1 on crit).
- [ ] **Experience chips**: selecting one adds its modifier to the roll and costs
      1 Hope; two experiences cost 2 Hope total.
- [ ] **Reaction toggle**: reaction roll generates **no** Fear/Hope.
- [ ] **Situational bonus**: free-text `1d6 + 2` lands in the roll formula.
- [ ] **Bonus-effect chips**: add an active effect on the actor changing
      `system.bonuses.roll.trait.bonus` → chip appears in the roll sheet; opt it
      out → total drops by the bonus; leave it on → bonus applies.
- [ ] Roll again with automation setting OFF → no automatic Hope/Fear changes
      (GM settings respected).

## C — Write rules

- [ ] **Weapon slots**: with a primary equipped, equip a two-handed weapon → old
      primary auto-unequips; equip a secondary while a two-handed is worn → the
      two-hander unequips. Never more than one primary + one secondary equipped.
- [ ] **Beastform lock**: apply a beastform effect (or transform via a Druid card)
      → equipping any weapon warns and is blocked; canceling beastform re-enables.
- [ ] **Armor exclusivity** (regression): equipping the second armor unequips the
      first.
- [ ] **Loadout cap**: fill the loadout to the world max → row vault-toggle on a
      vaulted card warns "loadout max reached" and card stays vaulted.
- [ ] **Recall with cost**: free a loadout slot; Recall a card with recall cost 2
      → system cost dialog appears → confirm → Stress +2 and card moves to
      loadout. Repeat and **cancel** → no Stress change, card stays vaulted.
- [ ] **Recall cost 0 / To Vault**: zero-cost recall moves instantly; "To Vault"
      always works regardless of cap.

## D — Pocket rest (Downtime)

- [ ] Short rest, full budget: chat card posted with the picked moves; card's own
      buttons (heal, clear stress…) still work from the GM/desktop side.
- [ ] Item resource with formula max resets to the **evaluated number** (open the
      item: value is e.g. `3`, not `1 + @tier` or blank); increasing-progression
      resource resets to 0.
- [ ] Action uses with shortRest recovery reset to 0.
- [ ] An active effect with duration "until short rest" is **removed** after the
      full rest (with `autoExpireActiveEffects` ON) and **kept** with it OFF.
- [ ] Partial rest (budget not fully spent): chat card posts, refreshables and
      effects untouched.

## E — Regression smoke

- [ ] Vitals: HP/Stress/Hope pips tap + long-press edit; thresholds scale marks
      1/2/3 HP; armor slots adjust via `updateArmorValue` (marks move on the item).
- [ ] Death move button appears at full HP marks and opens the system dialog.
- [ ] Domain card / feature actions: spend sheet and duality sheet still open;
      costs charge; uses tick.
- [ ] Item CRUD: create (+), delete (confirm), quantity stepper.
- [ ] Chat mode: messages render natively (duality cards look like the sidebar's),
      journal mode loads, unread badge counts.
- [ ] Bio tab renders enriched background/connections.
- [ ] No console errors on sheet open, tab switches, or any of the above.
      Watch especially for warnings from `parseItemFormula`/`Roll` and any
      `undefined` in labels.

## Sign-off

- [ ] All boxes above green on phone + forced pocket mode.
- [ ] Promote: pull on **live** instance, re-run section E only as smoke.
- [ ] Tag release + package `dist` zip.

# Release blocker — Rules-correct writes

Audit basis: Foundryborne/daggerheart **v2.5.4** (2026-07-16). These are writes
where the adapter mutates documents directly and skips a rule the system's own
sheet enforces. Unlike the read-parity items these can corrupt game state, so they
gate the release. All in `adapters/daggerheart.js`.

Delegation principle: where the system exposes the behavior (a document method, an
action) we call it; only where the rule lives in sheet-private code
(`static #handler`s we cannot call) do we port the rule, marked PORTED with the
source reference.

---

## W1 Weapon equip ignores slot + burden + beastform rules

`toggleEquip()` (~line 601) handles armor exclusivity only. For weapons the system
sheet (`character.mjs #toggleEquipItem`) enforces:

1. **Beastform lock** — an active `beastform`-type effect blocks equipping weapons
   (warn `DAGGERHEART.UI.Notifications.beastformEquipWeapon`).
2. **Slot rules** — `DhCharacter.unequipBeforeEquip(item)` (a **public static** on
   the character data model, `module/data/actor/character.mjs:711`): equipping a
   secondary unequips the current secondary and a two-handed primary; equipping a
   primary unequips the current primary and — when the new one is two-handed — the
   secondary.

Today the pocket sheet can produce three equipped weapons or two primaries, which
then breaks `primaryWeapon`/`secondaryWeapon` getters and weapon bonuses.

Fix in `toggleEquip`, weapon branch:
```js
if (actor.effects?.find?.((e) => !e.disabled && e.type === "beastform")) {
  ui.notifications?.warn(game.i18n.localize("DAGGERHEART.UI.Notifications.beastformEquipWeapon"));
  return;
}
const unequip = actor.system?.constructor?.unequipBeforeEquip;
if (typeof unequip === "function") await unequip.call(actor.system, item);
return item.update({ "system.equipped": true });
```
Older system versions without `unequipBeforeEquip` keep today's naive behavior
(feature-detect, don't version-check). Unequipping needs no rules.

## W2 Vault → loadout skips the loadout cap; Recall never pays its cost

`toggleVault()` (~line 619) flips `system.inVault` unconditionally. The system
sheet enforces (`character.mjs` context-menu `toLoadout`/`recall`, `#toggleVault`):

1. **Cap** — moving a card *out* of the vault requires
   `actor.system.loadoutSlot.available` (unless `system.loadoutIgnore`); otherwise
   warn `DAGGERHEART.UI.Notifications.loadoutMaxReached` and abort.
2. **Recall cost** — the Recall action charges `system.recallCost` as **Stress**
   before unvaulting. The system builds a transient `effect`-type action with
   `cost: [{ key: "stress", value: recallCost }]` and only unvaults when
   `action.use(event)` returns a config (cost paid / confirmed). PORTED from
   `character.mjs` recall context-menu handler — sheet-private, not callable.

Fix:
- `toggleVault` (used by the row's vault control): when unvaulting, check
  `loadoutSlot.available` first; warn + abort when full. Vaulting stays free.
- The detail panel's **Recall** action (`getItemDetail` domain-card branch,
  vaulted case ~line 1340) fires the same `vault` intent today. Add a distinct
  `recall` intent that ports the system's flow: cap check → if `recallCost > 0`,
  build the transient effect action exactly as the system does
  (`game.system.api.models.actions.actionsTypes.effect`, `getSourceConfig`,
  `chatDisplay: false`) and `use()` it (its spend popup is already caught by the
  pocket action-config path) → unvault only on truthy config. Feature-detect the
  action class; fall back to plain unvault (current behavior) when absent.
- Keep the raw `vault` intent for loadout→vault ("To Vault") unchanged.

Shell impact: none (new intent goes through the existing adapter `invoke` switch;
`ItemDetail.actions` already carries arbitrary intents).

## W3 Pocket rest writes unevaluated formula strings into item resources

`applyRest()` refreshables loop (~line 983):
```js
const resetValue = increasing ? 0 : res.max ? Roll.replaceFormulaData(res.max, actor) : 0;
```
Two bugs vs the system (`downtime.mjs takeDowntime`):
1. `Roll.replaceFormulaData` returns a **string**; the system wraps it:
   `new Roll(replaced).evaluateSync().total`. We write `"2 + 1"` into a
   NumberField → validation error / NaN.
2. The data argument must be `actor.getRollData()`, not the actor document.

Fix: mirror the system exactly (`evaluateSync`), reusing the R6 formula helper from
the read-parity spec.

## W4 Pocket rest never expires rest-scoped active effects

System `takeDowntime` ends with `expireActiveEffects(actor, [shortRest|longRest])`
(`module/helpers/utils.mjs:476`): when the Automation setting
`autoExpireActiveEffects` is on, effects whose `system.duration.type` matches the
rest (plus `act`-duration ones) are deleted. Our port stops after resetting
refreshables, so "until your next rest" effects survive a pocket rest.

Fix: the helper is not exported on `game.system.api`. PORT it (small, setting-gated
— it no-ops when automation is off, so GM settings stay respected): filter
`actor.getActiveEffects()`… actually `actor.effects` + `allApplicableEffects` per
the helper, match `system.duration.type` against
`CONFIG.DH.GENERAL.activeEffectDurations` the way `expireActiveEffectIsAllowed`
does (skip `temporary`/`custom`; `act` always expires; rest types via
`refreshIsAllowed`), and `deleteEmbeddedDocuments`. Guard every config read; on any
miss, skip expiry silently (older versions didn't have it either).

Run it in the same "full budget taken" branch that resets refreshables — that
mirrors the system's gate.

---

## Verification

Live world, system 2.5.x:
- Equip two-handed weapon while a secondary is equipped → secondary auto-unequips;
  try equipping while in beastform → warning, no change.
- Fill the loadout, try moving a vault card up → warning, card stays; Recall a
  card with recall cost 2 → Stress +2 and card unvaults; cancel the spend → card
  stays vaulted.
- Feature with resource max `1 + @tier` (decreasing recovery `shortRest`): take a
  full short rest from the pocket sheet → value is a *number* equal to the
  evaluated max; with `autoExpireActiveEffects` on, a shortRest-duration effect is
  gone; with the setting off, it stays.

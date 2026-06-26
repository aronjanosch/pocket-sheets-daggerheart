# Phase 5 — Mobile polish (Daggerheart design parity)

Implements the gaps between `Daggerheart Mobile Sheet.dc.html` (claude.ai design
project) and the shipped app. Daggerheart-focused; no multi-system work.

> **Core principle holds.** The design is a self-contained *mock* — it fakes every
> system behavior (`Math.random` rolls, rest math, recall→stress, spend-Hope). The
> real app must **delegate to the Daggerheart system** and never own dice or rules.
> Each feature below splits into **UI (shell)** + **delegation (adapter → system)**.

Locked decisions (2026-06-26):
- **Roll banner:** mirror the *system's* roll — never fake dice. Shell hooks
  `createChatMessage`; the **adapter** parses the system's message (system knowledge
  stays in the adapter). Shell renders a lightweight banner.
- **Rest:** keep delegating to the system's **Downtime dialog**. Do not reimplement
  downtime-move math. The header button just opens the real dialog.
- **Cleanup:** remove the multi-system scaffolding (see Phase 0).

---

## Phase 0 — Remove multi-system artifacts

Independent of the feature work; do first to shrink the surface.

1. **Stub adapter + devStub**
   - Delete `scripts/stub-adapter.js`.
   - In `scripts/main.js`: drop the `stubAdapter` import, the `devStub`
     `game.settings.register`, and the `ready`-hook block that registers it.
   - Remove `settings.devStub.*` strings from `lang/en.json`.
2. **Trim contract to Daggerheart's needs** (`scripts/contract.js` + shell massaging)
   - `StatGridBlock`: drop `rank` (PF2 T/E/M/L). Remove the `RANK` map in
     `sheet.js#statGrid` + `ms-rank-*` CSS.
   - `ResourceBlock`: drop `die` (5e hit dice) and `tracks` / `display:"tracks"`
     (spell slots). Remove `isTracks` branch in `sheet.js#resource`, the tracks
     markup in `resource.hbs`, and `die`/`tracks` CSS.
   - `Intent`: drop the never-fired `setResource` doc note? — keep (slider uses it).
   - Keep `spellcast` (Daggerheart spellcast trait uses it).
3. **Docs** — `README.md` + `ROADMAP.md`: remove Phase 4 dnd5e / "module per system"
   framing; restate scope as *Daggerheart-first, adapter contract remains the
   extension point*. Keep the adapter architecture description (still true).
4. **`DIRECTION.md`** — delete (its per-system-module debate is settled). The private
   claude.ai review artifact has no delete API; remove it from the claude.ai UI.

**Risk:** trimming `tracks`/`die`/`rank` is safe — only the stub used them; no shipped
adapter emits them (`grep` confirms `daggerheart.js` never sets them).

---

## Phase A — Item-detail bottom sheet  *(highest value; was roadmap #1)*

Replaces `openItem → item.sheet.render(true)` (desktop sheet on a phone) with the
design's in-sheet panel: glyph · tag · name · badges · description · action buttons.

**Contract** (`contract.js`) — one new **pure** method + typedef:
```
getItemDetail(actor, itemId) => ItemDetail | null   // PURE, like getViewModel
ItemDetail = {
  glyph, iconTone?, accent?, tag, name,
  badges:  [{ label, value, tone? }],
  desc?:   string,            // pre-enriched AND escaped by the adapter
  actions: [{ label, intent, variant?: "primary"|"ghost"|"danger"|"default",
              sub?, itemId?, uuid?, key? }]
}
```
Returning `null` → shell falls back to the current desktop-sheet behavior (safety net).

**Shell** (`sheet.js`):
- `#onOpenItem` → call `adapter.getItemDetail(actor, itemId)`; if non-null,
  `#openDetailSheet(detail)` via the existing `#mountSheet`; else current fallback.
- `#openDetailSheet` renders header/badges/desc/actions; each action button
  dispatches its `intent` (reusing `useItem` / `equip` / `vault` / `toChat` /
  `rollTrait`). Close on backdrop/✕.
- New CSS for the detail panel (badges grid, action buttons).

**Adapter** (`daggerheart.js`) — implement `getItemDetail` per kind:
- **Domain card:** badges Domain/Level/Recall; actions *Send to Chat* (`toChat`),
  *Move to Vault* / *Recall to Loadout* (`vault`).
- **Weapon:** badges Trait/Range/**Damage formula**/Burden; actions *Roll Attack*
  → `useItem` (the system rolls the attack — **not** a faked banner), *Equip/Unequip*
  (`equip`), *Send to Chat*.
- **Armor:** badges Score/Major/Severe; *Equip/Unequip*, *Send to Chat*.
- **Consumable/loot:** badges Type/Qty; *Use* (`useItem`) for consumables, *Send to Chat*.

**Delegation note:** "Recall costs Stress", "Use heals 1d4" etc. are *system* effects —
we only fire `vault` / `useItem`; the system applies the cost. No client-side math.

---

## Phase B — Tappable damage thresholds

Design: tapping Minor/Major/Severe marks 1/2/3 HP. Current `ScaleBlock` is read-only.

**Contract:** `ScaleBlock.segments[]` gains optional `mark` (HP delta) + the block
gains `markKey` (resource key). Absent → read-only as today.

**Shell** `#scale`: when `mark` present, render the segment as a button dispatching
`adjustResource { key: markKey, delta: mark }`.

**Adapter** `thresholdsScale`: add `markKey:"hitPoints"`, `mark:-1/-2/-3` to the three
zones. Delegation = existing `adjustResource` → `actor.update`. Trivial.

---

## Phase C — Free dice roller  *(shell-only; no contract change)*

Design: a `⚅` button beside the primary action → bottom sheet pool builder
(d4–d20 with counts) + modifier stepper + Roll.

**Shell** (`sheet.js`): `#openDiceRoller()` via `#mountSheet`. Build a formula like
`2d10 + 1d6 + 3` and roll with **Foundry's own API** —
`new Roll(formula).toMessage({ speaker: ChatMessage.getSpeaker({ actor }) })` — so it
posts to shared chat like any roll. Optionally show the evaluated total inline before
posting. No system coupling (core `Roll`).

**View model:** add `ViewModel.diceRoller?: boolean` (default true for Daggerheart) so
an adapter can hide the generic roller if a system doesn't want it.

**Tray layout:** primary button + secondary `⚅` button (see Phase F).

---

## Phase D — Features tab polish

Design: collapsible sections (Experiences / Heritage / Class / Subclass), inline
descriptions, per-feature **uses pips**, and a highlighted **Hope Feature** card.

**Contract:**
- `HeadingBlock`: add `collapsible?: boolean` + `sectionId`. Blocks after a
  collapsible heading (until the next heading) hide when collapsed.
- `ActionItem`: add `desc?` (pre-escaped html, shown inline), `featured?` (the
  accented Hope-feature card style), and `uses?: { value, max }` rendered as tappable
  diamond pips.
- New intent `setUses { itemId, value }` for tapping a feature's use pips.

**Shell:**
- Track collapsed `sectionId`s in shell-local state (like `#activeTab`); `#massage`
  skips blocks under a collapsed heading. `selectSection` action toggles.
- `#actionList` renders `desc`, `featured` styling, and `uses` pips (reuse `#pips`).
- `setUses` dispatch + action.

**Adapter:** mark the section headings collapsible; attach `desc` to feature rows
(enrich is async → keep escaped text for now, same caveat as `bioTab`); map a feature's
system uses to `uses`; flag the Hope feature `featured`. `setUses` → update the item's
uses field (**VERIFY** the field path on a live world before writing).

**Delegation note:** the Hope feature's "Spend 3 Hope" is `item.use()` — fire `useItem`,
let the system spend. Don't compute the spend.

---

## Phase E — Roll-result banner  *(mirror, never fake)*

Design shows Hope/Fear dice + outcome + damage in-sheet. We surface the **system's**
result, not our own.

**Contract:** optional `readRoll(message) => RollResult | null` on the adapter (system
parsing stays in the adapter). `RollResult = { hope, fear, total, outcome, advDie?,
damage? }`.

**Shell:** hook `createChatMessage`; if `message.speaker.actor === this.actor.id`,
call `adapter.readRoll(message)`; non-null → `#showRollBanner(result)` (auto-dismiss /
tap to dismiss), styled per the design. Tear down the hook in `_onClose` (alongside the
existing item hooks).

**Adapter:** implement `readRoll` by reading the Daggerheart duality-roll message flags
(`message.flags.daggerheart` / system roll data). **VERIFY** the flag/roll shape on a
live world — this is the only fragile, version-sensitive piece; fail soft (`null`) when
the shape is unrecognized so we degrade to the plain chat card.

---

## Phase F — Header rest button, tray layout, toasts  *(polish)*

- **Header rest (`☾`):** add `ViewModel.headerAction?` (e.g. `{ icon, intent:"rest" }`).
  Shell renders it in the identity header; tap → `rest` intent → system Downtime dialog
  (per decision). Remove the `restButtons` block from `vitals` once relocated.
- **Tray:** primary Duality button + secondary `⚅` dice button (Phase C), matching the
  design's sticky tray.
- **Toasts:** small shell helper `#toast(msg)` for transient confirmations
  (equip/vault/use). Lowest priority — the live re-render already reflects state; toasts
  are a nicety.

---

## Suggested order

`0 (cleanup)` → `A (item detail)` → `B (thresholds)` → `C (dice roller)` →
`D (features)` → `E (roll banner)` → `F (polish)`.

A–C are self-contained and low-risk. D adds the most contract surface. E carries the
only live-world verification risk; keep it last and behind a soft-fail.

## Contract change summary

| Addition | Phase | Kind |
|----------|-------|------|
| `getItemDetail(actor, itemId)` + `ItemDetail` | A | new pure method |
| `ScaleBlock.segments[].mark`, `markKey` | B | additive field |
| `ViewModel.diceRoller?` | C | additive field |
| `HeadingBlock.collapsible`, `sectionId` | D | additive field |
| `ActionItem.desc`, `featured`, `uses` | D | additive fields |
| `setUses` intent | D | new intent |
| `readRoll(message)` + `RollResult` | E | new optional method |
| `ViewModel.headerAction?` | F | additive field |
| *removed:* `rank`, `die`, `tracks` | 0 | trim |

All feature changes are additive; nothing breaks existing adapters.

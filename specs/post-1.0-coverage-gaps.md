# Post-1.0 — Coverage gaps vs the official character sheet

Features the system's character sheet has that the pocket sheet doesn't. None block
release (nothing here corrupts state or hides existing UI); ordered by expected
impact at a real table. Audit basis: Foundryborne/daggerheart v2.5.4 sheet
(`module/applications/sheets/actors/character.mjs` + templates).

---

## G1 Unarmed attack

The system sidebar shows `system.usedUnarmed` (the actor's built-in attack action,
`system.attack`, default "Unarmed Attack") whenever it applies. The pocket Items tab
only lists weapon items — a character with nothing equipped has **no attack roll
reachable** on the phone.

Sketch: in `itemsTab()` (or Vitals), when no weapon is equipped (mirror the
system's `usedUnarmed` gate), emit an actionList row for `system.attack` — it's a
real action with a `uuid`, so the existing `useItem { uuid }` path (duality sheet,
popup suppression) works unchanged. Read half needs a row builder; act half needs
nothing.

## G2 Companion actor (Ranger beastbound)

`actorTypes: ["character"]` — a Ranger's companion sheet falls back to the desktop
sheet on the phone. The system's companion is a lean actor (stress 3 pips,
experiences, attack action, level-ups tied to the ranger).

Sketch: add `"companion"` to `actorTypes` and branch `getViewModel` on
`actor.type`: companion = identity + stress resource + traits-free statGrid
(evasion), attack action row, experiences. Companion rolls use the same
`rollTrait`/action machinery (`actor.rollClass` is DualityRoll for companions).
Launcher: actor picker already lists owned actors — verify it doesn't filter to
`character`.

## G3 Beastform awareness (Druid)

Active beastform = an `effect` of type `beastform`. The pocket sheet doesn't show
it, and (after W1) weapon-equip taps fail against an invisible state. The system
sheet shows a marker + `cancelBeastform` action.

Sketch: Vitals tag/button when `actor.effects.find(e => e.type === "beastform" && !e.disabled)`
— label from the effect name, tap = confirm + delete the effect (the system's
cancel path). Entering beastform stays on the desktop dialog (compendium browsing;
out of pocket scope).

## G4 Level-up entry point

Level and pending level-ups are invisible; `levelManagement` /
`viewLevelups` open the system's level-up application. Full level-up flow on a
phone is out of scope, but in **forced pocket mode on desktop** (v0.9.1 feature)
the dialog is perfectly usable.

Sketch: after the read-parity fix shows "Level N" in the identity, make the
identity subtitle (or a Vitals button) fire an `openLevelUp` intent →
`new (game.system.api.applications.levelup ?? …)` — resolve the class via
`game.system.api`, feature-detect, no-op when absent. Show only when
`actor.system.levelData.canLevelUp` (verify exact getter at build time).

## G5 Bio extras

`system.biography.characteristics` (pronouns / age / faith) and `system.scars`
(reduces Hope max — players wonder why their Hope cap shrank). Cheap: one `info` or
`statGrid` block on the Bio tab; scars as a count near Hope.

## G6 Chat-mode audit for interactive system cards

Chat mode now renders every message natively (`message.getHTML()`, v0.9.x). Foundry
fires the render hooks the system uses to wire its card buttons, so most should
work — but in phone sheet-only mode (canvas off, sidebar chat hidden) listeners
that assume the core chat-log DOM may not. Needs a live-world audit:
downtime move buttons, damage apply, duality reroll targets. Outcome decides
whether we (a) re-dispatch clicks to the system's handlers, or (b) hide dead
buttons and rely on the GM screen.

---

Explicitly out of scope (unchanged): party sheet, item transfer between players,
countdowns management, character creation/reset, adversary/environment actors, GM
tooling.

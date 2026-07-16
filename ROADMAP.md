# Pocket Sheets — Daggerheart · Roadmap

Current state: shell + Daggerheart adapter feature-complete for daily play (vitals,
duality rolls, items, loadout, rest, chat mode, iPad layout). This roadmap tracks the
work between **now and the 1.0 release**, sourced from a line-by-line audit of the
adapter against **Foundryborne/daggerheart v2.5.4** (2026-07-16, see `specs/`).

> **Scope discipline holds.** This is only the mobile character sheet. Map, sync,
> permissions, dice, and chat come from Foundry core; rules come from the system.
> Adapters delegate — they never reimplement dice or rules math.

---

## Release blockers (1.0)

Two specs, both required before release. **Status: implemented 2026-07-16
(uncommitted); remaining gate is the live-world verification pass listed at the
end of each spec.**

### 1. Read-path parity — [specs/release-read-parity.md](specs/release-read-parity.md)
Fields the adapter reads that don't exist (or moved) in system 2.5.x. All degrade
silently today — blocks render empty or features never appear:

- Weapon trait/range/damage read from pre-2.x paths → weapon rows/detail show no stats.
- Armor score reads `baseScore` (migrated away) → no score badge.
- ~~`getChatCard` duality cards~~ — fixed by native chat rendering (v0.9.x,
  `message.getHTML()`); dead `getChatCard` code removed with the R-fixes.
- Bonus-effect chips read `effect.changes` before `effect.system.changes` → chips
  never appear in the roll sheet.
- Identity subtitle reads `system.level` (doesn't exist) → level never shown.
- Item-resource formula parsing breaks on compound formulas (`1 + @tier`).
- Minor: proficiency rendered as a modifier (`+2`), gold fallback drops `coins`,
  scalable-cost `max` formulas unresolved.

### 2. Rules-correct writes — [specs/release-write-rules.md](specs/release-write-rules.md)
Places where the adapter writes state directly and skips rules the system sheet
enforces:

- Weapon equip ignores primary/secondary slots, two-handed burden, and the
  beastform lock → players can equip an illegal set from the phone.
- Vault → loadout ignores the loadout cap, and **Recall never charges its Stress
  cost**.
- Pocket rest: refreshed item resources are written as *unevaluated formula strings*;
  rest-scoped active effects are never expired.

---

## Post-1.0 — coverage gaps

[specs/post-1.0-coverage-gaps.md](specs/post-1.0-coverage-gaps.md) — features the
official sheet has that the pocket sheet doesn't. Ordered by expected play impact:

1. **Unarmed attack** — no weapon equipped → no attack roll reachable at all.
2. **Companion actor** (Ranger beastbound) — pocket sheet is `character`-only.
3. **Beastform awareness** (Druid) — no indicator, no cancel, equip lock invisible.
4. **Level-up entry point** — at minimum a button opening the system's level
   management (usable in forced-pocket desktop mode).
5. Bio extras — pronouns/age/faith, scars.
6. Chat-mode audit for non-duality system cards (damage/healing buttons, downtime
   move buttons) in phone sheet-only mode.

Out of scope (unchanged): party sheets, countdown management, GM tooling,
character creation/reset, multi-system adapters as a near-term goal.

---

## Compatibility note (affects both specs)

System releases on the Foundry **v13** line are older than 2.5.x; the v14 line
(2.5.4) is where the audit ran. The adapter's `MIN_VERSION` is `2.0.0`, so every fix
must **dual-read** (`new path ?? old path`) rather than swap paths — the old path may
still be live on v13 worlds. Where behavior (not just shape) changed, prefer feature
detection over version checks.

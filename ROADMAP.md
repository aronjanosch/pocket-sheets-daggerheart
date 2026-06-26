# Pocket Sheet — Roadmap

A free, MIT-licensed FoundryVTT module: mobile-friendly character sheets for in-person play. Players open their sheet on a phone/tablet; the DM drives one shared map on a big screen — mirroring how a real in-person session works.

> **Scope discipline:** This is *not* a VTT. It is *only* the mobile character sheet. The shared map, token movement, live sync, permissions, dice, and chat are already provided by Foundry core — we do not rebuild them. Simplicity is the primary design goal.

---

## Guiding principles

1. **Lean on Foundry core.** No custom backend, no WebSocket server, no auth, no sync code. Actor data already syncs across clients; rolls already post to shared chat.
2. **One thin shell + per-system adapters.** Core module is system-agnostic. Each game system is one self-contained adapter file. This is the open-source extension point.
3. **Mobile-first, not desktop-shrunk.** Big tap targets, single-column, thumb-reachable actions.
4. **No build step.** Plain ESM + Handlebars + lang JSON, loaded natively by Foundry. Lowest barrier for community contributors.

---

## Target — support v13 **and** v14 (first-class)

Many users are still on v13 while others (incl. the maintainer) run v14. Both are supported by one codebase:

- Foundry compat: **min `13`, verified `14`**. The shell API (ApplicationV2 / ActorSheetV2 / HandlebarsApplicationMixin) is stable across both — no version branching in the shell.
- **The real cross-version risk lives in adapters, not the shell.** A system's `actor.system` shape can differ between the version that runs on v13 and the one on v14 (e.g. Daggerheart 2.4.1 requires v14; older releases ran on v13). Adapters must read defensively (optional chaining, fallbacks) and fail soft when a field is absent.
- Adapter contract therefore includes a **capability/availability check** so the shell can show a graceful "unsupported version/system" state instead of crashing.

---

## Phases

### Phase 0 — Foundations
- Repo, MIT license, README, contribution guide.
- Module skeleton: `module.json`, ESM entry, lang scaffold, mobile-first CSS base.
- Define the **adapter contract** (the community extension interface) — its own spec.

### Phase 1 — Core shell
- A registered mobile `ActorSheetV2` (the shared shell, no system logic).
- Renders purely from an adapter-provided view model; all rolls delegate to the system's own roll API.
- Responsive template + blocks (vitals, actions, inventory).

### Phase 2 — First adapter: Daggerheart
- Map `actor.system` → view model: HP, Stress, Hope, traits.
- Delegate duality rolls + feature/weapon use to the system.
- Validates the adapter abstraction against a real, opinionated system.

### Phase 3 — Activation & actor selection
- **Mobile detection** to auto-present the mobile sheet (switching sheets by hand on a phone is painful).
- **Actor selector** for players who own multiple actors (default to assigned character).
- *Candidate to split into its own milestone or defer to v2 depending on effort.*

### Phase 5 — Mobile polish (Daggerheart design parity)
- Item-detail bottom sheet, free dice roller, tappable thresholds, features-tab
  polish, roll-result banner. See [specs/phase-5-mobile-polish.md](specs/phase-5-mobile-polish.md).
- Accessibility, theming, error states, empty/edge cases; package + listing.

> **Focus:** Daggerheart-first. A second adapter (dnd5e, pf2e, …) is a later bet, not a
> near-term goal — but the contract stays the seam that makes it a drop-in when it comes.

---

## Open extension model

```
core shell  →  adapter contract  →  adapters/{daggerheart, ...}
```

Adding a system = one new adapter file + registration. No core changes. This is what MIT + open source is meant to unlock — even though Daggerheart is the only adapter we maintain today.

---

## Explicitly out of scope (v1)

- Shared map / VTT features (Foundry core already does this).
- Custom sync, backend, accounts, phone-join/QR auth.
- Editing campaign content, GM tooling, automation engines.
- Build tooling / bundler.

---

## Deliverables sequence

Roadmap (this doc) → per-phase **specs** → per-phase **implementation**. Specs and code are produced separately, one phase at a time.

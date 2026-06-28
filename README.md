# Pocket Sheets — Daggerheart

A free, MIT-licensed [Foundry VTT](https://foundryvtt.com/) module: **mobile-friendly character sheets for in-person play.**

Players open their character sheet on a phone or tablet; the GM drives one shared map on a big screen — mirroring how a real in-person session works.

> **Scope:** This is *not* a VTT. It is *only* the mobile character sheet. The shared map, token movement, live sync, permissions, dice, and chat are already provided by Foundry core — Pocket Sheets — Daggerheart does not rebuild them.

## Installation

In Foundry: **Add-on Modules → Install Module**, paste this manifest URL:

```
https://github.com/aronjanosch/pocket-sheets-daggerheart/releases/latest/download/module.json
```

Then enable **Pocket Sheets — Daggerheart** in your world's module settings.

## Status

Early development, **Daggerheart-first**. Foundry compatibility: **minimum v13, verified v14.**

| Phase | What | State |
|------|------|-------|
| 0 | Foundations: skeleton, adapter contract, registry | ✅ done |
| 1 | Core shell: the system-agnostic mobile sheet | ✅ done |
| 2 | Daggerheart adapter | ✅ done |
| 3 | Activation & actor selection | ✅ done |
| 5 | Mobile polish: item detail, dice roller, roll banner | spec'd |

The adapter contract stays the extension point — other systems can be added later
(by us or contributors) without touching the shell. Daggerheart is the focus today.

## How it works

```
core shell  →  adapter contract  →  adapters/{daggerheart, ...}
```

- The **shell** is one registered `ActorSheetV2`. It contains zero system knowledge. It renders a normalized, block-based view model and turns taps into abstract *intents*.
- An **adapter** is one file per game system. It maps that system's `actor.system` into the view model (read) and translates intents into the system's own document methods — rolls, item use, updates (act). Rolls and updates stay with the system and Foundry core, so the module never owns dice math or sync.

Adding support for a new system is one new adapter file and a single `register()` call — **no core changes.** See [CONTRIBUTING.md](CONTRIBUTING.md).

## Design principles

1. **Lean on Foundry core.** No backend, no WebSocket server, no auth, no sync code.
2. **One thin shell + per-system adapters.** The adapter is the open-source extension point.
3. **Mobile-first, not desktop-shrunk.** Big tap targets, single column, thumb-reachable actions.
4. **No build step.** Plain ESM + Handlebars + lang JSON, loaded natively by Foundry.

## License

[MIT](LICENSE).

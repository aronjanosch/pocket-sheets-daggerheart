# Pocket Sheets — Daggerheart

A free, MIT-licensed [Foundry VTT](https://foundryvtt.com/) module: **mobile-friendly character sheets for in-person play.**

Players open their character sheet on a phone or tablet; the GM drives one shared map on a big screen — mirroring how a real in-person session works.

> **Scope:** This is *not* a VTT. It is *only* the mobile character sheet. The shared map, token movement, live sync, permissions, dice, and chat are already provided by Foundry core — Pocket Sheets — Daggerheart does not rebuild them.

## Screenshots

| | | |
|---|---|---|
| ![Vitals](docs/screenshots/SCR-20260629-tjgt.png) | ![Features](docs/screenshots/SCR-20260629-tjjo.png) | ![Loadout](docs/screenshots/SCR-20260629-tjlf.png) |
| Vitals — HP, stress, hope, armor, traits | Features — class, subclass, abilities | Loadout — domain cards & actions |
| ![Roll options](docs/screenshots/SCR-20260629-tjnb.png) | ![Card detail](docs/screenshots/SCR-20260629-tjpk.png) | |
| Roll sheet — advantage, bonus, experiences | Card detail — full text & actions | |

On a tablet the same view model re-flows into a three-pane layout:

![Tablet layout](docs/screenshots/SCR-20260629-tias.png)

## Installation

In Foundry: **Add-on Modules → Install Module**, paste this manifest URL:

```
https://github.com/aronjanosch/pocket-sheets-daggerheart/releases/latest/download/module.json
```

Then enable **Pocket Sheets — Daggerheart** in your world's module settings.

## Pocket mode

The **Pocket mode** setting (per device, under Module Settings) controls whether this
device shows the fullscreen sheet with the map canvas off:

- **Auto** (default) — on for phones and tablets, off on desktop.
- **Always** — on everywhere (a desktop GM keeps their map).
- **Never** — full Foundry interface with the map, even on a tablet.

You can also switch on the fly:

- **Leave** — tap the ⤢ button in the sheet's top corner → back to full Foundry.
- **Return** — on a tablet/phone that left, a floating phone button appears → tap to go back in.

Prefer a hotbar button? The module ships a **Pocket Sheets — Macros** compendium with a
**Toggle Pocket Mode** macro — open the Compendium Packs sidebar, drag it onto your hotbar,
and tap it to switch this device in or out. (It calls the API below.)

Scripting it yourself? The public API on any device:

```js
const api = game.modules.get("pocket-sheets-daggerheart").api;
api.enterPocketMode(); // fullscreen sheet, map off
api.exitPocketMode();  // full Foundry, map on
```

Both flip this device's Pocket mode setting and reload.

## Design principles

1. **Lean on Foundry core.** No backend, no WebSocket server, no auth, no sync code.
2. **One thin shell + per-system adapters.** The adapter is the open-source extension point.
3. **Mobile-first, not desktop-shrunk.** Big tap targets, single column, thumb-reachable actions.
4. **No build step.** Plain ESM + Handlebars + lang JSON, loaded natively by Foundry.

## License

[MIT](LICENSE).

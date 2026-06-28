# Contributing

Thanks for helping make Pocket Sheets — Daggerheart better. The highest-value contribution is usually **a new system adapter** — that's the whole point of the architecture.

## Ground rules

- **No build step.** Plain ESM, Handlebars, and lang JSON, loaded natively by Foundry. Don't add a bundler.
- **The shell stays system-agnostic.** Anything that knows about a specific system belongs in an adapter, never in `scripts/`.
- **Delegate, never reimplement.** Adapters must not build dice rolls, format chat, or write sync logic. Call the system's own document methods and let Foundry core do the rest.
- Foundry compatibility target: **minimum v13, verified v14.**

## Project layout

```
module.json            manifest (compat, esmodules, styles, lang)
scripts/
  main.js              entry: registry bootstrap + public API + ready hook
  registry.js          adapter registry (register / resolve by system id)
  contract.js          JSDoc typedefs: the adapter interface + view model
adapters/
  <system>.js          one file per system (the extension point)
templates/             shell template + block partials (Phase 1)
styles/pocket-sheets-daggerheart.css
lang/en.json
```

## How to write a system adapter

An adapter is a plain object implementing the [`PocketSheetAdapter`](scripts/contract.js) interface. It has two halves: **read** (pure: actor → view model) and **act** (named intents that delegate to the system).

### 1. Create `adapters/<your-system>.js`

```js
import { register } from "../scripts/registry.js";

export const myAdapter = {
  systemId: "my-system",          // must equal game.system.id
  actorTypes: ["character"],      // which actor types get the mobile sheet

  // Cheap, side-effect-free, never throws. Refuse versions you can't read.
  checkAvailability() {
    const okVersion = foundry.utils.isNewerVersion(game.system.version, "1.0.0");
    if (!okVersion) return { ok: false, reason: "Requires My System 1.x or newer." };
    return { ok: true };
  },

  // PURE: no async, no DOM, no writes. Read defensively (?. and ??).
  getViewModel(actor) {
    const sys = actor.system ?? {};
    return {
      identity: { name: actor.name, img: actor.img, subtitle: "Level 1" },
      blocks: [
        { kind: "resource", key: "hp", label: "HP",
          value: sys.hp?.value ?? 0, max: sys.hp?.max ?? null, editable: true },
        { kind: "statGrid", stats: [
          { key: "str", label: "Strength", value: sys.abilities?.str?.value ?? 0, rollable: true }
        ]},
        // actionList and info blocks as needed...
      ]
    };
  },

  // Translate abstract intents into the system's own methods. Delegate only.
  async invoke(actor, intent) {
    switch (intent.type) {
      case "rollStat":       return actor.rollAbility?.(intent.key, { event: intent.event });
      case "useItem":        return actor.items.get(intent.itemId)?.use?.(intent.event);
      case "adjustResource": return actor.update({ [`system.${intent.key}.value`]: /* clamp */ });
      case "openItem":       return actor.items.get(intent.itemId)?.sheet?.render(true);
      default:               return; // unknown intent → no-op
    }
  }
};

// Self-register at init.
Hooks.once("init", () => register(myAdapter));
```

### 2. Register it

Built-in adapters import and `register()` from their own `init` hook (as above). Wire the import into `scripts/main.js` so it loads.

A **third-party module** can register without touching this repo at all — listen for the ready hook or use the public API. Both are load-order safe:

```js
Hooks.on("pocketSheetsDaggerheart.ready", (api) => api.register(myAdapter));
// or:
game.modules.get("pocket-sheets-daggerheart")?.api?.register(myAdapter);
```

### 3. The view model

The shell renders only the normalized model in [`scripts/contract.js`](scripts/contract.js). Four block kinds cover most systems:

| kind | renders | emits intent |
|------|---------|--------------|
| `resource` | label, `value/max`, optional bar, +/- stepper | `adjustResource{key, delta}` |
| `statGrid` | grid of stats; rollable ones are tappable | `rollStat{key}` |
| `actionList` | title + tappable item rows | `useItem{itemId}` / `openItem{itemId}` |
| `info` | title + pre-enriched, **safe** HTML | none |

Adding a block kind touches the shell and is reviewed for cross-system value — try to fit the existing four first.

### Rules that keep adapters thin

- `getViewModel` is **pure** — no async, no DOM, no writes. It runs on every render.
- Return **display-ready strings** (`"Hope"`, `"Agility"`). The adapter owns its system's vocabulary; localize via the `pocket-sheets-daggerheart` lang files. The shell never resolves system i18n keys.
- Read **defensively** — optional chaining and fallbacks — so a system's v13-vs-v14 data-shape differences degrade gracefully instead of throwing.
- Use `checkAvailability` to refuse a version you can't read; the shell shows your `reason` instead of crashing.

## Submitting

- One adapter per pull request keeps review easy.
- Test on a real character of the target system on both v13 and v14 where possible.
- Note which system version you verified against.

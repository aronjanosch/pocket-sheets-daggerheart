/**
 * Pocket Sheets — Daggerheart — adapter contract (v2: themed, tabbed block vocabulary).
 *
 * JSDoc typedefs only. No runtime logic lives here. This file is the single
 * source of truth for the interface every system adapter implements and the
 * normalized view model the shell renders. See specs/ and the "Modular Sheet
 * Architecture" design.
 *
 * One shell, every system. The shell renders ONLY this normalized view model and
 * never reads `actor.system`. A system ships *data + one accent color* — never
 * CSS. Two halves:
 *   - read: `getViewModel(actor)` is PURE — actor -> ViewModel, no DOM, no writes.
 *   - act:  `invoke(actor, intent)` delegates each intent to the system's own
 *           document methods (rolls / item use / update / status effects). The
 *           shell never owns dice math, chat formatting, or sync.
 */

// ---------------------------------------------------------------------------
// Adapter interface
// ---------------------------------------------------------------------------

/**
 * @typedef {object} PocketSheetAdapter
 * @property {string}   systemId   Must equal `game.system.id` to be selected.
 * @property {string[]} actorTypes Actor types this adapter renders, e.g. ["character"].
 * @property {() => AdapterAvailability} checkAvailability
 *   Inspect `game.system.version` / presence of expected APIs. Cheap,
 *   side-effect-free, never throws. Gates the shell's "unsupported" state.
 * @property {(actor: Actor) => ViewModel} getViewModel
 *   PURE: no async, no DOM, no writes. Safe to call on every render. Reads
 *   defensively (optional chaining + fallbacks) so cross-version data drift
 *   degrades gracefully instead of throwing.
 * @property {(actor: Actor, intent: Intent) => Promise<void|unknown>} invoke
 *   Translate an abstract intent into the system's own method. Delegates —
 *   never reimplements a SYSTEM's dice/chat/sync. Unknown intent types: no-op.
 *   Usually resolves to nothing (the actor/item update flows back via hooks); a
 *   few intents resolve to a result the shell displays inline, since the chat log
 *   can be hidden in phone sheet-only mode: `rollDice` → the evaluated Roll;
 *   `rollTrait` / `useItem` (a roll action) → a {@link RollResult} for the banner,
 *   or null when the use had no roll.
 * @property {(actor: Actor, itemId: string) => (ItemDetail | null)} [getItemDetail]
 *   PURE (like getViewModel): build an in-sheet detail panel for one owned item.
 *   Returning `null` lets the shell fall back to the system's desktop item sheet.
 *   Optional — adapters without it always get the desktop fallback.
 * @property {(actor: Actor, ref: {itemId?: string, uuid?: string, trait?: string}) => (ActionConfig | Promise<ActionConfig>)} [getActionConfig]
 *   Inspect what desktop popup using an item/action WOULD raise, so the shell can open
 *   a pocket bottom sheet instead of letting the system pop a desktop dialog. Reads
 *   documents; never writes. The shell then fires a `useItem` (or `rollTrait`) intent
 *   carrying the player's picks. Optional — adapters without it get the system's own
 *   popups on use.
 * @property {(actor: Actor, key: string) => (RestConfig | null)} [getRestConfig]
 *   Inspect what a rest ("short"/"long") offers, so the shell can open a pocket rest
 *   sheet instead of the system's desktop downtime dialog. Reads settings/documents;
 *   never writes. The shell then fires a `rest` intent carrying the player's `picks`.
 *   Returning `null` (or omitting it) falls back to a bare `rest` intent (desktop dialog).
 * @property {(message: ChatMessage) => (ChatCard | null)} [getChatCard]
 *   PURE: interpret one chat message into a compact, system-flavored roll card (Hope/Fear
 *   dice, outcome, damage) for the shell's Chat mode. The shell owns the chat list, plain
 *   message bubbles, whispers, and system dividers (all core-Foundry, system-agnostic);
 *   this is the one seam where a system gives a roll its own card. Return `null` for any
 *   message that isn't a recognizable roll — the shell then renders the message's own
 *   content HTML generically. Reads documents; never writes; never throws.
 */

/**
 * Result of `checkAvailability`. `ok:false` carries a player-readable reason
 * the shell shows in its "unsupported" state.
 * @typedef {{ ok: true } | { ok: false, reason: string }} AdapterAvailability
 */

// ---------------------------------------------------------------------------
// Intents (shell -> adapter). Keep the set small and additive.
// ---------------------------------------------------------------------------

/**
 * @typedef {object} Intent
 * @property {"rollStat"|"rollTrait"|"rollDice"|"useItem"|"openItem"|"adjustResource"|"setResource"|"rollResourceDice"|"toggleResourceDie"|"adjustItemResource"|"toggleTag"|"toggleItem"|"toChat"|"expChat"|"equip"|"vault"|"rest"|"deathMove"|"primary"} type
 * @property {string} [key]     Stat key (rollStat/rollTrait), resource key (adjustResource/setResource), die index (toggleResourceDie), tag key (toggleTag), experience id (expChat), or button key (rest: "short"/"long").
 * @property {string} [formula] Dice expression for the generic dice roller (rollDice), e.g. "2d6 + 1d8 + 3".
 * @property {string} [itemId]  Item id (useItem / openItem / toggleItem / toChat / equip / vault / rollResourceDice / toggleResourceDie / adjustItemResource).
 * @property {string} [uuid]    Action uuid (useItem on a specific action — drives the system's action with the popups suppressed).
 * @property {number} [delta]   Resource step (adjustResource), e.g. +1 / -1.
 * @property {number} [value]   Absolute resource value (setResource) from slide-to-set.
 * @property {string} [statKey] Active stat key the shell passes with a `primary` action.
 * @property {"advantage"|"neutral"|"disadvantage"} [advantage] Roll-sheet advantage choice (rollTrait / useItem roll action).
 * @property {number} [difficulty]              Optional roll difficulty from the roll sheet (rollTrait).
 * @property {string[]} [experiences]           Experience ids to apply to the roll (rollTrait / useItem); each spends 1 hope.
 * @property {string} [bonus]                   Free-text situational-bonus formula added to the roll, e.g. "1d6 + 2" (rollTrait / useItem).
 * @property {boolean} [reaction]               Roll as a reaction — no Fear generated (rollTrait / useItem roll action).
 * @property {string[]} [bonusOff]              Bonus-effect ids the player opted out of for this roll (rollTrait / useItem).
 * @property {boolean} [spend]                  Mark a useItem as a non-roll resource spend (suppresses the spend / action-picker dialog).
 * @property {Record<string, number>} [scale]  Per-cost extra scale steps for a spend action (useItem, keyed by cost key).
 * @property {Record<string, Record<string, number>>} [picks] Rest-sheet selections (rest), `{ [category]: { [moveKey]: count } }`.
 * @property {Event}  [event]   Forwarded DOM event for modifier-key / dialog behavior.
 */

/**
 * A finished roll, normalized for the shell's transient result banner. The adapter
 * maps the system's own roll result into this; the shell renders it generically
 * (tinting by `outcome`, no system vocabulary) and auto-dismisses it. The chat log
 * can be hidden in phone sheet-only mode, so this is how a player sees the outcome.
 * @typedef {object} RollResult
 * @property {number} total              Grand total (including modifiers).
 * @property {"crit"|"hope"|"fear"|"flat"} outcome  Drives the banner's accent.
 * @property {string} [label]            Display-ready outcome text (adapter-localized).
 * @property {RollResultDie[]} [dice]    Notable per-die values (e.g. Hope / Fear).
 * @property {boolean} [success]         Pass/fail vs a difficulty, when one applied.
 *
 * @typedef {object} RollResultDie
 * @property {string} label              Display-ready die label.
 * @property {number|string} value       Display-ready die value.
 * @property {ResourceTone} [tone]       Shell-owned tint for the value.
 */

/**
 * A roll chat message interpreted into a compact card for the shell's Chat mode — the
 * phone-native form of a system's duality / attack chat card. Returned by the optional
 * `getChatCard` adapter hook; the shell renders it generically (tinting by `outcome`,
 * Hope/Fear dice tiles, an optional damage strip) with no system vocabulary. The shell
 * supplies the surrounding chrome (author, avatar, timestamp) — this is only the result.
 * @typedef {object} ChatCard
 * @property {number} total              Grand total of the roll.
 * @property {"crit"|"hope"|"fear"|"flat"} outcome  Drives the card's accent.
 * @property {string} [label]            Display-ready outcome text (adapter-localized).
 * @property {string} [action]           What was rolled, e.g. "Warhammer Attack · Str".
 * @property {number} [hope]             Hope die face, shown in the gold tile.
 * @property {number} [fear]             Fear die face, shown in the purple tile.
 * @property {{kind:"adv"|"dis", value:number}} [adv]  Advantage/disadvantage die, if any.
 * @property {ChatCardDamage} [damage]   Damage roll bundled with the attack, if any.
 *
 * @typedef {object} ChatCardDamage
 * @property {string} label              Weapon / source name.
 * @property {string} [formula]          Display-ready formula, e.g. "d10+2".
 * @property {number} total              Damage total.
 */

// ---------------------------------------------------------------------------
// Normalized view model (system-agnostic). The shell renders only this.
// ---------------------------------------------------------------------------

/**
 * @typedef {object} ViewModel
 * @property {Theme}     [theme]    The one style a system owns: its accent color.
 * @property {Identity}  identity
 * @property {TopStat[]} [topStats] Small header stat boxes (Evasion/Prof, AC/Perc…).
 * @property {Tab[]}     tabs       Ordered tabs; the shell renders the active one's blocks.
 * @property {Primary}   [primary]  Sticky bottom action button (Duality Roll / Roll d20).
 */

/**
 * The only theming an adapter does. The shell maps these to CSS custom
 * properties; everything else (layout, type, spacing, gestures) is shell-owned.
 * @typedef {object} Theme
 * @property {string} accent       e.g. "#d8b35c".
 * @property {string} [accentDeep] Darker accent for gradients; defaults from accent.
 */

/**
 * @typedef {object} Identity
 * @property {string} name
 * @property {string} [img]      Portrait; if absent the shell shows `initials`.
 * @property {string} [initials] Fallback monogram, e.g. "AV".
 * @property {string} [subtitle] e.g. "Level 3 Guardian · Stalwart".
 */

/**
 * A small boxed stat in the header.
 * @typedef {object} TopStat
 * @property {string} label
 * @property {string|number} value
 * @property {boolean} [accent]  Tint the value with the system accent.
 */

/**
 * @typedef {object} Tab
 * @property {string}  id      Stable key (shell tracks the active tab by id).
 * @property {string}  label   Display-ready (adapter-localized).
 * @property {Block[]} blocks  Ordered; shell renders top-to-bottom when active.
 */

/**
 * The sticky primary action. The shell fires a `primary` intent on tap and, if a
 * selectable stat is active, overrides `sub` with that stat's label/value.
 * @typedef {object} Primary
 * @property {string} label    e.g. "✦ Duality Roll".
 * @property {string} [sub]    e.g. "STR +2" (default; shell may override).
 * @property {RollOptions} [rollOptions] Extra controls the shell renders in the roll
 *   bottom sheet (experiences to apply, current hope to gate them, a situational bonus).
 */

/**
 * Optional roll-sheet augmentations. The shell renders these generically and folds
 * the player's picks back into the rollTrait intent (`experiences`, `bonus`); the
 * adapter owns the system meaning (modifiers, hope cost). Omit to show only the
 * advantage toggle.
 * @typedef {object} RollOptions
 * @property {boolean} [bonus]            Show the flat situational-bonus stepper.
 * @property {boolean} [reaction]         Show the reaction toggle (a reaction roll makes no Fear).
 * @property {RollExperience[]} [experiences] Tap-to-apply experiences (each spends 1 hope).
 * @property {RollBonusEffect[]} [bonusEffects] Opt-out bonus effects (rendered on by default).
 * @property {{value:number, max:number|null}} [hope] Current hope, used to gate experience picks.
 *
 * @typedef {object} RollExperience
 * @property {string} key    Experience id, forwarded in intent.experiences.
 * @property {string} name   Display-ready name.
 * @property {number} value  Signed modifier the experience adds.
 *
 * @typedef {object} RollBonusEffect
 * @property {string} id     Active-effect id; deselecting adds it to intent.bonusOff.
 * @property {string} name   Display-ready effect name.
 */

/**
 * What configuring an item/action use requires — returned by `getActionConfig` so the
 * shell opens the right pocket sheet (and which `useItem` intent fields to fill).
 * @typedef {object} ActionConfig
 * @property {"pick"|"duality"|"spend"|"direct"} kind
 *   - `pick`  : the item has several actions; show a picker (`actions`), then re-ask for the chosen `uuid`.
 *   - `duality`: a roll action; show the roll sheet (this object also carries RollOptions).
 *   - `spend` : a non-roll resource cost; show the spend sheet (`costs`, `uses`).
 *   - `direct`: nothing to configure; just fire `useItem`.
 * @property {string} [uuid]   Action uuid to use (duality / spend / direct).
 * @property {string} [title]  Display-ready action name for the sheet header.
 * @property {"advantage"|"neutral"|"disadvantage"} [advantage] Default advantage (duality).
 * @property {{uuid:string, name:string, icon?:string}[]} [actions] Choices (pick).
 * @property {SpendCost[]} [costs] Resource costs to confirm (spend).
 * @property {{value:number, max:number}} [uses] Limited uses, if any (spend).
 * @property {boolean} [bonus] @property {boolean} [reaction]
 * @property {RollExperience[]} [experiences] @property {RollBonusEffect[]} [bonusEffects]
 * @property {{value:number, max:number|null}} [hope]   (duality — see RollOptions.)
 *
 * What a rest offers — returned by `getRestConfig` so the shell can open a pocket rest
 * sheet. The player picks moves (gated per category by `max`), and the shell folds the
 * choices into a `rest` intent's `picks`.
 * @typedef {object} RestConfig
 * @property {string} title              Display-ready sheet header (e.g. "Short Rest").
 * @property {string} key                The rest key, echoed back in the intent ("short"/"long").
 * @property {RestCategory[]} categories Move groups in budget for this rest.
 *
 * @typedef {object} RestCategory
 * @property {string} key                Stable category id (forwarded in intent.picks).
 * @property {string} [label]            Display-ready category label (shell may localize by key).
 * @property {number} max                How many moves the player may take from this category.
 * @property {RestMove[]} moves          Pickable moves.
 *
 * @typedef {object} RestMove
 * @property {string} key                Stable move id (forwarded in intent.picks).
 * @property {string} name               Display-ready move name.
 * @property {string} [icon]             FontAwesome class, e.g. "fa-solid fa-bandage".
 * @property {string} [img]              Thumbnail image path.
 * @property {string} [desc]             RAW move HTML; the shell enriches it at render.
 *
 * @typedef {object} SpendCost
 * @property {string} key      Resource key (forwarded in intent.scale for scalable costs).
 * @property {string} label    Display-ready resource label.
 * @property {number} value    Base cost amount.
 * @property {number} [step]   Increment per scale step. Default 1.
 * @property {boolean} [scalable] Whether the player can scale this cost up.
 * @property {number|null} [max] Maximum total when scalable.
 */

/**
 * @typedef {ResourceBlock|ItemResourceBlock|StatGridBlock|TagsBlock|ActionListBlock|InfoBlock|HeadingBlock|ButtonsBlock|ScaleBlock} Block
 */

/**
 * A value/max tracker shown as a bar, pips, diamonds, or parallel tracks.
 * @typedef {object} ResourceBlock
 * @property {"resource"} kind
 * @property {string} key                 Used by the adjustResource intent.
 * @property {string} label               Display-ready (adapter-localized).
 * @property {ResourceTone} [tone]        Shell-owned role color. Default "accent".
 * @property {number} value
 * @property {number|null} max            null -> maxless stepper, no bar/pips.
 * @property {"bar"|"pips"|"diamond"} [display] Default "bar".
 * @property {number} [temp]              Temp HP -> "+N TEMP" badge.
 * @property {boolean} [editable]         Show the +/- stepper. Default true.
 *
 * @typedef {"hp"|"stress"|"armor"|"accent"|"info"} ResourceTone
 */

/**
 * An item-owned resource (Daggerheart Seraph Prayer Dice, an escalating die, a class
 * counter). The shell renders it on its own and fires itemId-scoped intents; all three
 * variants live in one block so adapters surface them uniformly.
 * @typedef {object} ItemResourceBlock
 * @property {"itemResource"} kind
 * @property {string} itemId              Owning item id; forwarded in every intent.
 * @property {string} label               Display-ready (usually the item name).
 * @property {"dice"|"die"|"count"} variant
 *   - `dice` : a pool of dice (`dice[]`); tap one → toggleResourceDie, reroll → rollResourceDice.
 *   - `die`  : a single escalating die; the ± stepper fires adjustItemResource.
 *   - `count`: a plain counter; the ± stepper fires adjustItemResource.
 * @property {ResourceTone} [tone]        Shell-owned role color. Default "accent".
 * @property {string} [img]               Die-face image (dice/die variants).
 * @property {ItemResourceDie[]} [dice]   The pool (dice variant).
 * @property {number} [value]             Current value (die / count variant).
 * @property {number|null} [max]          Upper bound, or null for an unbounded counter.
 *
 * @typedef {object} ItemResourceDie
 * @property {number} index               Die position; forwarded as intent.key.
 * @property {number|null} value          Rolled face value, or null if not yet rolled.
 * @property {boolean} [used]             Whether this die has been spent.
 */

/**
 * A grid of stat tiles. Rollable ones tap to roll; selectable ones tap to arm
 * the primary action (Daggerheart's two-step Duality Roll).
 * @typedef {object} StatGridBlock
 * @property {"statGrid"} kind
 * @property {number} [cols]      Columns. Default 3.
 * @property {StatEntry[]} stats
 *
 * @typedef {object} StatEntry
 * @property {string} [key]       Stat key for rollStat / primary (rollable or selectable).
 * @property {string} label       Display-ready.
 * @property {number|string} value
 * @property {number|string} [sub] Secondary value, e.g. ability score under the modifier.
 * @property {boolean} [save]     Show a save dot.
 * @property {boolean} [rollable] Tap -> rollStat.
 * @property {boolean} [select]   Tap -> arm the primary action (shell-local active state).
 * @property {boolean} [spellcast] Mark this tile as the spellcasting trait (wand badge).
 */

/**
 * Toggleable conditions, each with an optional value (Frightened 2, Exhaustion 1).
 * @typedef {object} TagsBlock
 * @property {"tags"} kind
 * @property {Tag[]} items
 *
 * @typedef {object} Tag
 * @property {string} key        Used by the toggleTag intent (e.g. a status id).
 * @property {string} label      Display-ready.
 * @property {number|string} [value] Optional stack/level shown beside the label.
 * @property {boolean} [active]   Currently applied.
 */

/**
 * A list of usable rows (weapons, spells, domain cards, actions).
 * @typedef {object} ActionListBlock
 * @property {"actionList"} kind
 * @property {string} [title]    Display-ready (or precede with a HeadingBlock).
 * @property {ActionItem[]} items
 *
 * @typedef {object} ActionItem
 * @property {string} [itemId]  Item id; absent for non-item rows (e.g. experiences keyed by `key`).
 * @property {string} [key]     Non-item key (experience id) used by controls like expChat.
 * @property {string} name
 * @property {string} [sub]      Secondary line (domain · level, school, range…).
 * @property {string} [img]      Thumbnail; falls back to `glyph`.
 * @property {string} [glyph]    Short symbol when there's no img (⚔ ✦ ✷ ➶).
 * @property {string} [cost]     Cost chip text (e.g. "✦1", "FREE", "◆").
 * @property {boolean} [costMuted] Render the cost chip muted (free/spent).
 * @property {string} [badge]    Right-side badge (damage, "LV 2", "AT WILL").
 * @property {boolean} [toggle]  Prepared/equipped toggle -> toggleItem intent.
 * @property {boolean} [use]     Whether tapping the row uses the item (-> useItem). Default true.
 * @property {SubAction[]} [actions] Inline buttons for an item's own actions (Daggerheart: "Mark a Stress", etc).
 * @property {Control[]} [controls]  Small control icons (equip / vault / post-to-chat).
 *
 * A button for one of an item's embedded actions. Tapping uses that action,
 * which the system resolves (spending its cost — mark stress, spend hope…).
 * @typedef {object} SubAction
 * @property {string} uuid       Action sub-document uuid; -> useItem intent with `uuid`.
 * @property {string} name       Display-ready action name.
 * @property {string} [icon]     FontAwesome class fragment, e.g. "fa-dice-d20".
 * @property {string} [uses]     Remaining/max uses chip, e.g. "2/3".
 *
 * A small control icon on an item row. The shell owns each kind's icon + intent.
 * @typedef {object} Control
 * @property {"equip"|"vault"|"chat"|"expChat"} kind
 * @property {boolean} [active]  Toggle state (equipped, or stored in vault).
 * @property {string} [key]      Non-item key the control acts on (expChat -> experience id).
 */

/**
 * Read-only text (notes, experiences, background).
 * @typedef {object} InfoBlock
 * @property {"info"} kind
 * @property {string} [title]    Display-ready.
 * @property {string} html       Either safe HTML the adapter already escaped, OR — when
 *   `enrich` is set — RAW system HTML the shell enriches at render (inline rolls, links,
 *   formatting) since getViewModel is sync/pure and cannot run the async enricher.
 * @property {boolean} [enrich]  Enrich `html` at render time instead of treating it as safe.
 * @property {string} [relativeToUuid] Document uuid to enrich relative to (rolls/@UUID
 *   links resolve against it). Defaults to the actor when omitted.
 */

/**
 * A section label that precedes grids/lists, with an optional count.
 * @typedef {object} HeadingBlock
 * @property {"heading"} kind
 * @property {string} label
 * @property {string|number} [count] e.g. "4 in loadout".
 */

/**
 * A row of action buttons not tied to an item (Short/Long rest, etc). Each
 * button's `action` must be a registered shell action; the shell dispatches an
 * intent of that type carrying `key`.
 * @typedef {object} ButtonsBlock
 * @property {"buttons"} kind
 * @property {ButtonEntry[]} items
 *
 * @typedef {object} ButtonEntry
 * @property {string} label   Display-ready.
 * @property {string} action  Intent type / registered shell action (e.g. "rest").
 * @property {string} [key]   Passed through as the intent `key` (e.g. "short").
 * @property {string} [icon]  FontAwesome class fragment, e.g. "fa-mug-hot".
 * @property {"danger"} [variant] Visual emphasis (e.g. a death-move alert button).
 */

/**
 * A compact labeled scale: ordered zone labels separated by boundary values.
 * Used for Daggerheart damage thresholds (Minor | major# | Major | severe# | Severe).
 * `bounds.length` must equal `segments.length - 1`.
 * @typedef {object} ScaleBlock
 * @property {"scale"} kind
 * @property {string} [label]            Optional caption (e.g. "Damage Thresholds").
 * @property {{label:string}[]} segments Zone labels, in order.
 * @property {{value:number|string}[]} bounds Boundary values shown between segments.
 */

/**
 * The in-sheet item detail panel — the phone-native replacement for popping the
 * system's desktop item sheet. The shell renders header (glyph · tag · name),
 * a badge grid, an optional pre-escaped description, and a column of action
 * buttons. Each action dispatches its `intent` (reusing the same intents item
 * rows already fire), so delegation stays in the adapter / system.
 * @typedef {object} ItemDetail
 * @property {string} glyph              Short symbol shown in the header tile (⚔ ✦ 🛡 ◈).
 * @property {ResourceTone} [iconTone]   Shell-owned tone for the glyph tile. Default accent.
 * @property {string} [accent]           Reserved; the shell currently ignores per-item accents.
 * @property {string} tag                Kind label above the name (e.g. "Weapon").
 * @property {string} name               Display-ready item name.
 * @property {ItemBadge[]} badges        Stat grid (Domain/Level, Trait/Range/Damage…).
 * @property {string} [desc]             Safe HTML the adapter escaped, OR — when `descEnrich`
 *   is set — RAW system HTML the shell enriches before mounting the panel.
 * @property {boolean} [descEnrich]      Enrich `desc` at render time instead of treating it as safe.
 * @property {string} [descRelativeToUuid] Document uuid to enrich `desc` relative to (the item).
 * @property {ItemAction[]} actions      Action buttons, in display order.
 *
 * @typedef {object} ItemBadge
 * @property {string} label              Display-ready caption.
 * @property {string|number} value       Display-ready value.
 * @property {ResourceTone} [tone]       Tint the value (e.g. damage in the hp tone). Default accent.
 *
 * A detail-panel action. The shell fires an Intent of type `intent` carrying the
 * supplied `itemId` / `uuid` / `key`; the adapter resolves it like any other.
 * @typedef {object} ItemAction
 * @property {string} label              Display-ready button text.
 * @property {Intent["type"]} intent     Intent type to dispatch (useItem / equip / vault / toChat / rollTrait…).
 * @property {"primary"|"ghost"|"danger"|"default"} [variant] Visual emphasis. Default "default".
 * @property {string} [sub]              Secondary line under the label.
 * @property {string} [itemId]           Forwarded as intent.itemId.
 * @property {string} [uuid]             Forwarded as intent.uuid (embedded action).
 * @property {string} [key]              Forwarded as intent.key.
 */

export {};

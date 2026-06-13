# 0006 — Influence replaces Faction Standing; per-guild Influence + per-faction Health

## Decision

The guild–faction relationship metric is renamed and a second, distinct metric is added.

- **Influence** is now the canonical term for a guild's 0–100 relationship with a faction
  (start 50), **replacing** "Faction Standing". This deliberately reverses the previous
  CONTEXT.md decision, which listed `_Avoid_: influence` under Faction Standing. Influence is
  stored **per guild × faction** (`guild.influence[factionId]`); each Seat's guild has its own.
- **Faction Health** is a new, single per-faction 0–100 value (start 70), the same for all
  guilds, that **linearly** scales how much that faction produces:
  `produced = base × Health/100`. (`base` is left undefined until Upkeep/per-turn production
  exists.)

These are different axes: Influence is a guild's relationship *with* a faction; Health is the
faction's own productive condition. A guild's **Headquarters** (a Plot or a Landmark) grants
+20 Influence with its district's faction.

## Why

"Influence" matches Rules.md's own language and the player-facing "Influence map overlay",
and the project owner prefers it; keeping "Standing" as the code/glossary term while the
Rules and UI say "Influence" was a standing source of confusion. Health is separated from
Influence because production should depend on the faction's condition, not on any one guild's
relationship with it.

## Consequences

- The save shape grows: guilds gain `influence`, `resources`, and `headquarters`; factions
  gain `health`. Older saves without these default (Influence 50/+20 HQ, Health 70) on load.
- Code, UI, and glossary that said "standing" move to "Influence"; "Standing" becomes an
  avoided synonym.
- The production formula is recorded now but not executed — there is no round/Upkeep loop yet.

## Status

Accepted.

## Context for the three ADR criteria

- **Hard to reverse:** the rename touches the glossary, server model, UI, and the persisted
  save shape.
- **Surprising without context:** it reverses an explicit prior CONTEXT.md `_Avoid_:
  influence` — a future reader needs to know this was intentional.
- **Trade-offs:** "Standing" vs "Influence" was a real prior decision; it was reversed to
  align code with the Rules and the UI.

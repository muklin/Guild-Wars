# 0003 — Server becomes authoritative: player identity, initiative turn-enforcement, live sync

## Decision

The server changes from a stateless, authority-free, single-machine REST endpoint into a
**stateful, identity-aware, turn-enforcing, real-time** multiplayer server for one game at
a time.

- **Identity:** players **join** with a name and receive a **Seat key**; every mutating
  request carries it (`X-Seat-Key`) so the server knows who is acting. No accounts/passwords.
- **Turn enforcement (chosen over a pure shared-whiteboard):** the server models
  **Initiative** (set by an in-app d20 roll per seat) and **gates** Setup mutations to the
  active seat. District Setup walks **Reversed Initiative**; Terrain Setup and Guild
  Creation walk forward.
- **Live sync:** a WebSocket layer broadcasts on every mutation. Clients no longer rely on
  "the acting client updates from its own response" — all connected seats reconcile live.
- **Per-seat redaction & secrets:** state is sent **per seat** (`getStateForSeat`), carrying
  shared state plus that seat's private data and redacting others'. A per-seat **secret
  store** with a generic **reveal** action provides the channel future secret round-actions
  will use.
- **Token ledger:** per-seat Veto/Guild/Character/Round Token counters are tracked and
  synced as plain shared numbers, **with no automated effects** — humans still adjudicate,
  matching the GM-less tabletop design.

Turn-enforcement currently applies only to the three **Setup sub-phases**, the only
server-implemented surface. The turn model is shaped so unbuilt game rounds
(Upkeep/Planning/Pay-the-Bills) can adopt it without rework.

## Why this and not a shared whiteboard

The alternative was a sync-only server that holds shared state + secrets but lets humans
enforce turns verbally (truest to the GM-less, vote-driven rules). Enforcement "(b)" was
chosen so cross-machine play has a single authority for whose turn it is and what is secret,
which a verbal honor system cannot guarantee between remote clients.

## Consequences

- Every existing `/api/setup/*` route gains identity + turn-gating; saves grow to include
  seats, initiative order, the turn pointer, the token ledger, and the private store.
- Broadcasting must be per-seat, not one global snapshot, or secrets would leak.
- Veto/ballot voting flows are **deferred**; the social layer here is turn-gating + a synced
  ledger + a secret channel only.

## Status

Accepted.

## Context for the three ADR criteria

- **Hard to reverse:** introduces identity, a turn state machine, a socket layer, per-seat
  state redaction, and a changed save format across server and client.
- **Surprising without context:** the tabletop game is explicitly GM-less and run by human
  voting/veto, so a future reader would not expect the *server* to enforce turns.
- **Trade-offs:** shared-whiteboard "(a)" vs turn-enforcer "(b)" were weighed; "(b)" was
  chosen for a single source of turn/secret authority across remote machines.

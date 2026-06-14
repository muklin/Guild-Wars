import crypto from 'crypto'

// Turn direction per Setup sub-phase. District Setup (CitySubdivision) runs in
// Reversed Initiative; Terrain Setup and Guild Creation run in forward Initiative.
// (See CONTEXT.md: Initiative / Reversed Initiative, and Game Rules/Rules.md.)
const STEP_DIRECTION = { Terrain: 'forward', CitySubdivision: 'reversed', GuildCreation: 'forward' }

// Veto tokens live on the seat (needed before a guild exists).
// Guild/Character/Month tokens live on the guild object itself.
const INITIAL_SEAT_TOKENS = () => ({ veto: 1 })

// The authoritative multiplayer layer: seats (player identity), the d20 initiative
// order, whose turn it is, the per-player Token ledger, and a per-seat secret store.
// It holds NO game/world state — that stays in GameStateManager/SetupPhase. This
// class only answers "who is playing, whose turn is it, and what is private to whom".
export default class MultiplayerManager {
  constructor() {
    this.seats = new Map()        // seatId -> seat
    this.initiativeOrder = []     // [seatId] in rolled (descending) order
    this.activeIndex = 0          // pointer into the current step's ordered seats
    this.started = false          // false = Lobby (players gathering)
    this.nextSeatId = 1
    this.secrets = new Map()      // seatId -> { key: value }  (never sent to other seats)
  }

  // ── Identity ────────────────────────────────────────────────────────────────
  join(name) {
    const trimmed = (name || '').trim()
    if (!trimmed) throw new Error('A player name is required')
    // Reclaim an existing seat with the same name — lets a player who reloaded (F5)
    // or lost their key get back into a game in progress by re-entering their name.
    for (const seat of this.seats.values()) {
      if (seat.name.toLowerCase() === trimmed.toLowerCase()) { seat.connected = true; return seat }
    }
    // Otherwise create a new seat. Joining mid-game is allowed (for now): a late seat
    // is appended to the initiative order with its own d20 roll so it can take turns.
    const id = this.nextSeatId++
    const seat = {
      id,
      name: trimmed,
      seatKey: crypto.randomBytes(16).toString('hex'),
      guildId: null,
      connected: true,
      initiativeRoll: this.started ? 1 + Math.floor(Math.random() * 20) : null,
      passed: false,
      tokens: INITIAL_SEAT_TOKENS(),
    }
    this.seats.set(id, seat)
    if (this.started && !this.initiativeOrder.includes(id)) this.initiativeOrder.push(id)
    return seat
  }

  resolveByKey(seatKey) {
    if (!seatKey) return null
    for (const seat of this.seats.values()) if (seat.seatKey === seatKey) return seat
    return null
  }

  setConnected(seatKey, connected) {
    const seat = this.resolveByKey(seatKey)
    if (seat) seat.connected = connected
    return seat
  }

  // ── Lobby / initiative ────────────────────────────────────────────────────────
  rollInitiative() {
    if (this.started) throw new Error('Initiative is locked once the game has started')
    if (this.seats.size === 0) throw new Error('No players have joined yet')
    const seats = [...this.seats.values()]
    for (const s of seats) s.initiativeRoll = 1 + Math.floor(Math.random() * 20)
    // Highest roll acts first; ties broken by join order (seat id) for determinism.
    seats.sort((a, b) => (b.initiativeRoll - a.initiativeRoll) || (a.id - b.id))
    this.initiativeOrder = seats.map(s => s.id)
    return this.initiativeOrder.map(id => {
      const s = this.seats.get(id)
      return { seatId: id, name: s.name, roll: s.initiativeRoll }
    })
  }

  start() {
    if (this.started) return
    if (this.initiativeOrder.length === 0) throw new Error('Roll initiative before starting')
    this.started = true
    this.activeIndex = 0
    this._resetPasses()
  }

  // ── Turn order ──────────────────────────────────────────────────────────────
  // Seat ids ordered for `step` (reversed for District Setup).
  orderForStep(step) {
    const dir = STEP_DIRECTION[step] || 'forward'
    return dir === 'reversed' ? [...this.initiativeOrder].reverse() : [...this.initiativeOrder]
  }

  activeSeatId(step) {
    if (!this.started || this.initiativeOrder.length === 0) return null
    const order = this.orderForStep(step)
    return order.length ? order[this.activeIndex % order.length] : null
  }

  isActive(seatKey, step) {
    const seat = this.resolveByKey(seatKey)
    return !!seat && seat.id === this.activeSeatId(step)
  }

  // Advance to the next seat in this step's order; returns the new active seat id.
  endTurn(step) {
    if (!this.started || this.initiativeOrder.length === 0) return null
    const order = this.orderForStep(step)
    this.activeIndex = (this.activeIndex + 1) % order.length
    return order[this.activeIndex]
  }

  pass(seatId, step) {
    const seat = this.seats.get(seatId)
    if (seat) seat.passed = true
    return this.endTurn(step)
  }

  allPassed() {
    return this.seats.size > 0 && [...this.seats.values()].every(s => s.passed)
  }

  // Reset the turn pointer + passes when the Setup sub-phase changes.
  onStepChanged() {
    this.activeIndex = 0
    this._resetPasses()
  }

  _resetPasses() {
    for (const s of this.seats.values()) s.passed = false
  }

  // ── Token ledger ──────────────────────────────────────────────────────────────
  resetForNewGame() {
    this.started = false
    this.initiativeOrder = []
    this.activeIndex = 0
    for (const seat of this.seats.values()) {
      seat.guildId        = null
      seat.initiativeRoll = null
      seat.passed         = false
      seat.tokens         = INITIAL_SEAT_TOKENS()
    }
  }

  resetAllTokens() {
    for (const seat of this.seats.values()) seat.tokens = INITIAL_SEAT_TOKENS()
  }

  adjustToken(seatId, kind, delta) {
    const seat = this.seats.get(seatId)
    if (!seat) throw new Error(`Seat ${seatId} not found`)
    if (kind !== 'veto') throw new Error(`Seat only holds veto tokens; use guild.tokens for '${kind}'`)
    seat.tokens.veto = Math.max(0, (seat.tokens.veto ?? 0) + delta)
    return seat.tokens
  }

  // ── Secret store ────────────────────────────────────────────────────────────
  putSecret(seatId, key, value) {
    if (!this.secrets.has(seatId)) this.secrets.set(seatId, {})
    this.secrets.get(seatId)[key] = value
  }

  // Pop a secret out so a caller can move it into shared state. Returns null if absent.
  revealSecret(seatId, key) {
    const bag = this.secrets.get(seatId)
    if (!bag || !(key in bag)) return null
    const value = bag[key]
    delete bag[key]
    return { seatId, key, value }
  }

  // ── Per-seat view (redacted) ─────────────────────────────────────────────────
  // Shared multiplayer state for everyone, plus ONLY the requesting seat's secrets.
  getStateForSeat(seatKey) {
    const me = this.resolveByKey(seatKey)
    const seats = [...this.seats.values()].map(s => ({
      seatId: s.id,
      name: s.name,
      connected: s.connected,
      initiativeRoll: s.initiativeRoll,
      passed: s.passed,
      guildId: s.guildId,
      tokens: s.tokens,            // Token counts are public
      isMe: !!me && s.id === me.id,
    }))
    return {
      started: this.started,
      seats,
      initiativeOrder: this.initiativeOrder,
      meSeatId: me?.id ?? null,
      activeSeatByStep: {
        Terrain: this.activeSeatId('Terrain'),
        CitySubdivision: this.activeSeatId('CitySubdivision'),
        GuildCreation: this.activeSeatId('GuildCreation'),
      },
      mySecrets: me ? (this.secrets.get(me.id) || {}) : {},
    }
  }

  // ── Persistence ───────────────────────────────────────────────────────────────
  serialize() {
    return {
      seats: [...this.seats.values()],
      initiativeOrder: this.initiativeOrder,
      activeIndex: this.activeIndex,
      started: this.started,
      nextSeatId: this.nextSeatId,
      secrets: [...this.secrets.entries()],
    }
  }

  deserialize(data = {}) {
    this.seats = new Map((data.seats || []).map(s => [s.id, s]))
    this.initiativeOrder = data.initiativeOrder || []
    this.activeIndex = data.activeIndex || 0
    this.started = !!data.started
    this.nextSeatId = data.nextSeatId || (this.seats.size + 1)
    this.secrets = new Map(data.secrets || [])
    // Sockets re-mark connected on reconnect; assume disconnected on load.
    for (const s of this.seats.values()) s.connected = false
  }

  clear() {
    this.seats.clear()
    this.initiativeOrder = []
    this.activeIndex = 0
    this.started = false
    this.nextSeatId = 1
    this.secrets.clear()
  }
}

export const HQ_UPGRADES = [
  // ── Defensive ───────────────────────────────────────────────────────────────
  {
    id: 'reinforced-walls',
    title: 'Reinforced Walls',
    category: 'Defensive',
    cost: { Gold: 50 },
    description: 'The HQ is hardened against assault. Any hostile action directly targeting the Headquarters has disadvantage.',
  },
  {
    id: 'watchtower',
    title: 'Watchtower',
    category: 'Defensive',
    cost: { Gold: 40 },
    description: 'A lookout post monitors all approaches. The guild receives advance notice of any faction action targeting the HQ\'s district one round before it resolves.',
  },
  {
    id: 'safe-house',
    title: 'Safe House',
    category: 'Defensive',
    cost: { Gold: 35 },
    description: 'Hidden rooms and false passages protect the guild. Guild members cannot be tracked to the HQ by hostile factions.',
  },
  // ── Economic ─────────────────────────────────────────────────────────────────
  {
    id: 'treasury-vault',
    title: 'Treasury Vault',
    category: 'Economic',
    cost: { Gold: 75 },
    description: 'A reinforced vault secures the guild\'s wealth. Stockpiled gold cannot be stolen or raided from the Headquarters.',
  },
  {
    id: 'merchants-ledger',
    title: "Merchant's Ledger",
    category: 'Economic',
    cost: { Gold: 50 },
    description: 'A meticulous record of contacts and prices gives the guild an edge. The guild earns +10% value on all trade deals brokered from the HQ.',
  },
  // ── Political ────────────────────────────────────────────────────────────────
  {
    id: 'grand-guildhall',
    title: 'Grand Guildhall',
    category: 'Political',
    cost: { Gold: 100 },
    description: 'An impressive hall projects power and legitimacy across the city. The guild gains +10 Standing with every faction immediately on purchase.',
  },
  {
    id: 'embassy-office',
    title: 'Embassy Office',
    category: 'Political',
    cost: { Gold: 60 },
    description: 'A formal diplomatic wing opens channels to all factions. The guild may send one diplomatic messenger per round at no action cost.',
  },
  // ── Member ───────────────────────────────────────────────────────────────────
  {
    id: 'training-grounds',
    title: 'Training Grounds',
    category: 'Member',
    cost: { Gold: 60 },
    description: 'A dedicated yard for drills and sparring. Characters stationed at the HQ can train: level-up costs 1 fewer Character Token.',
  },
  {
    id: 'infirmary',
    title: 'Infirmary',
    category: 'Member',
    cost: { Gold: 45 },
    description: 'A well-stocked sick bay staffed by a competent healer. Downed guild members recover and return to duty in 1 round instead of 2.',
  },
  // ── Intelligence ─────────────────────────────────────────────────────────────
  {
    id: 'archive-room',
    title: 'Archive Room',
    category: 'Intelligence',
    cost: { Gold: 50 },
    description: 'Shelves of dossiers, maps, and intercepted correspondence. Once per round the guild may ask the GM one yes/no question about any faction\'s activities, plans, or resources.',
  },
  {
    id: 'pigeonhole',
    title: 'Pigeonhole',
    category: 'Intelligence',
    cost: { Gold: 30 },
    description: 'A loft of trained carrier pigeons and anonymous informants. Once per round, learn which district has the most active espionage.',
  },
  // ── Prestige ─────────────────────────────────────────────────────────────────
  {
    id: 'trophy-annex',
    title: 'Trophy Annex',
    category: 'Prestige',
    cost: { Gold: 80 },
    description: 'A wing of trophies, banners, and relics from past victories. The visible history of triumph boosts morale — guild members gain +1 to all Charisma checks.',
  },
]

export const UPGRADE_BY_ID = new Map(HQ_UPGRADES.map(u => [u.id, u]))

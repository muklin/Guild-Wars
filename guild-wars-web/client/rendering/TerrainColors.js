export default {
  // Terrain types
  City: 0x808080,
  Plains: 0xb2de69,
  Desert: 0xedca72,
  Mountains: 0x8d8d8d,
  Forest: 0x218c21,
  Lake: 0x1a5abf,
  Sea: 0x0e6e6c ,
  //Delta: 0x66bf99,  
  Hills: 0x699B4F,
  Swamp: 0x4a6b4a,
  unassigned: 0xb8a680,

  // Terrain edge types
  Cliff: 0xaaaaaa,
  River: 0x4488ff,

  // City edge types
  Wall:     0x555555,
  MainRoad: 0x70717C,
  Canal:    0x3399cc,
  Docks:    0x2a7a9e,

  // Street surface types (micro-Voronoi layer)
  Mud:   0x6b4c2a,
  Brick: 0x9e3a22,
  Stone: 0x888fa0,


  // District classes
  Neutral: 0xDAD2AC,
  Market: 0xffd700,
  Military: 0x8b0000,
  Magical:  0xc39bef,
  Religious: 0xffff00,
  Residential: 0xb8956a,
  Noble:    0x9C62CC,
  Middle:   0xFFF385,
  Slums:    0xa08860,
  Entertainment: 0xff69b4,
  Industry: 0xbdb76b,
  Agricultural: 0x228b22,

  // Leadership type + subclasses
  Leadership: 0x4a1a6a,
  Monarchy:   0xdaa520,
  Republic:   0x2878b5,
  Tyrant:     0x8b1515,
  Oligarchy:  0x4b7c59,
  Theocracy:  0xd4c17f,
  Anarchist:  0xcc4400,

  get(type) {
    return this[type] || this.unassigned
  }
}

export default {
  // Terrain types
  City: 0x808080,
  Plains: 0xb2de69,
  Desert: 0xedca72,
  Mountains: 0x8d8d8d,
  Forest: 0x218c21,
  Lake: 0x1a5abf,
  Sea: 0x1a3a7a,
  Delta: 0x66bf99,
  Hills: 0x8d7359,
  Swamp: 0x4a6b4a,
  Wasteland: 0x5a4a3a,
  unassigned: 0xb8a680,

  // District classes
  Neutral: 0xb3b3b3,
  Commerce: 0xffd700,
  Military: 0x8b0000,
  Magical: 0x9932cc,
  Religious: 0xffff00,
  Noble: 0xffffe0,
  Slums: 0x8b7355,
  Entertainment: 0xff69b4,
  Industrial: 0xbdb76b,
  Agricultural: 0x228b22,

  get(type) {
    return this[type] || this.unassigned
  }
}

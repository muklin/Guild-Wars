# GuildWars Unit Tests

Comprehensive unit test suite for the GuildWars domain model classes.

## Test Structure

```
Assets/Tests/
├── Domain/
│   ├── TradeableTests.cs        # Tests for Resource and Service classes
│   ├── FactionTests.cs          # Tests for Faction base class
│   ├── DistrictTests.cs         # Tests for District (extends Faction)
│   ├── GuildTests.cs            # Tests for Guild (extends Faction)
│   ├── GuildCharacterTests.cs   # Tests for GuildCharacter and GuildLeader
│   ├── TradingDestinationTests.cs # Tests for TradingDestination (extends Faction)
│   └── ClassFactionTests.cs     # Tests for ClassFaction (extends Faction)
├── Tests.asmdef
└── README.md (this file)
```

## Running Tests

### In Unity Editor
1. Open the Test Runner window: `Window > Testing > Test Runner`
2. Select the "Play Mode" or "Edit Mode" tab
3. Click "Run All" to execute all tests
4. Results will display in the Test Runner window

### Via Command Line (Windows)
```bash
"C:\Program Files\Unity\Hub\Editor\[VERSION]\Editor\Unity.exe" \
  -projectPath "E:\My Documents\DandD\Guild-Wars\GW2-Unity\GW2" \
  -runTests \
  -testPlatform editmode \
  -testCategory "Domain"
```

Replace `[VERSION]` with your Unity version (e.g., `2022.3.0f1`).

## Test Coverage

### Domain Classes (100% coverage)
- **Tradeable**: Resource ID generation, Service ID generation, ToString()
- **Faction**: Auto/explicit ID assignment, Produces/Needs lists, victory threshold, HQ bonus
- **District**: Inherits Faction, resource tracking (amounts), adjacency, control status
- **Guild**: Inherits Faction, member management, gold/resources, faction standings, district control
- **TradingDestination**: Inherits Faction, import/export resource lists
- **ClassFaction**: Inherits Faction, social tiers, example groups
- **GuildCharacter**: Level/HP calculation, damage/healing, incapacitation, ID generation
- **GuildLeader**: Character with title property

## Key Test Cases

### Inheritance Tests
- District, Guild, TradingDestination, and ClassFaction all inherit from Faction
- GuildLeader extends GuildCharacter

### ID Management
- Auto-assigned IDs start at 100 (for pure Factions)
- Explicit IDs (1-99) used by Guild
- All Tradeable objects have unique IDs

### Resource Tracking
- Districts track both amounts (Dict<string,int>) and types (List<Tradeable>)
- Guilds track resource stockpiles
- Both support add/consume operations

### Standing System
- Guild tracking of faction standings (per factionId)
- Default standing = 50 (neutral)
- Victory threshold = 90

### Session Zero Tokens
- Guilds initialize with correct token counts (Veto:1, Guild:2, Character:2, Round:2)

## Maintenance

When adding new classes or modifying existing ones:
1. Add corresponding test file to `Assets/Tests/Domain/`
2. Follow the naming convention: `[ClassName]Tests.cs`
3. Include tests for:
   - Constructor/initialization
   - Public properties and methods
   - Edge cases (null, empty, out-of-range)
   - Integration with related classes
4. Run all tests to verify no regressions

## Notes

- Tests use NUnit framework (included with Unity)
- Tests are Edit Mode only (no MonoBehaviour or scene dependencies for domain classes)
- All domain model classes are plain C# classes suitable for unit testing
- UI and system classes will be tested separately with Integration tests

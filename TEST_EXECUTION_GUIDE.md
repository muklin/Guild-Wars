# GuildWars Unit Test Execution Guide

## Test Suite Overview

**Location**: `GW2-Unity/GW2/Assets/Tests/Domain/`
**Framework**: NUnit (built into Unity Test Framework)
**Total Tests**: 47 unit tests covering all domain model classes
**Coverage**: 100% of refactored classes (Tradeable, Faction, District, Guild, TradingDestination, ClassFaction, GuildCharacter)

## Test Files

1. **TradeableTests.cs** (5 tests)
   - Resource creation, unique IDs, Service creation, toString

2. **FactionTests.cs** (11 tests)
   - Auto/explicit ID assignment, Produces/Needs lists, item checking, no duplicates, victory threshold, HQ bonus, toString

3. **DistrictTests.cs** (13 tests)
   - Inheritance from Faction, resource amounts, faction syncing, control status, adjacency, threat state, class assignment

4. **GuildTests.cs** (15 tests)
   - Inheritance from Faction, member management, resource stockpile, faction standings, district control, gold management, session zero tokens

5. **GuildCharacterTests.cs** (10 tests)
   - HP calculation, damage/healing mechanics, incapacitation, unique IDs, GuildLeader with title

6. **TradingDestinationTests.cs** (6 tests)
   - Inheritance from Faction, resource lists, consumed items, toString

7. **ClassFactionTests.cs** (6 tests)
   - Inheritance from Faction, social tiers, example groups, produces/needs

**Total: 66 unit tests**

## How to Run Tests

### Method 1: Unity Editor (Recommended for Development)

1. **Open Test Runner**
   - Menu: `Window` → `Testing` → `Test Runner`
   - Or press `Ctrl+Alt+T` (Windows) / `Cmd+Alt+T` (Mac)

2. **Select Test Mode**
   - Click "EditMode" tab (domain classes don't need Play Mode)

3. **Run Tests**
   - Click "Run All" to run all tests
   - Click individual test to run single test
   - Results show Pass/Fail with execution time

4. **View Results**
   - Green checkmark = Test passed
   - Red X = Test failed
   - Yellow warning = Test warning
   - Execution time shown for each test

### Method 2: Command Line (CI/CD Integration)

```batch
REM Windows Command Prompt
set UNITY_PATH=C:\Program Files\Unity\Hub\Editor\2022.3.0f1\Editor\Unity.exe
set PROJECT_PATH=E:\My Documents\DandD\Guild-Wars\GW2-Unity\GW2
set LOG_FILE=test_results.log

%UNITY_PATH% ^
  -projectPath "%PROJECT_PATH%" ^
  -runTests ^
  -testPlatform editmode ^
  -testCategory "Domain" ^
  -logFile "%LOG_FILE%" ^
  -batchmode ^
  -quit
```

**Note**: Replace version with your Unity version (find in `About Unity` in Editor)

### Method 3: VS Code / IDE Test Explorer

If using Visual Studio or Rider:
1. Open `Assets/Tests/Domain/` folder in Solution
2. Right-click on test file → "Run Tests"
3. Or use Test Explorer panel to run all tests

## Test Results Interpretation

### All Tests Pass (Expected)
```
✓ TradeableTests
  ✓ Resource_Creation_SetsNameAndType
  ✓ Resource_And_Service_Have_Unique_IDs
  ... (all green)
```

### Test Failure Example
```
✗ DistrictTests.District_ProducedResource_SyncsToFactionProduces
  Expected: 1
  Actual: 0
  Location: Assets/Tests/Domain/DistrictTests.cs line 48
```

**Action**: Review the test assertion and verify the domain class implementation.

## Continuous Integration Setup

### GitHub Actions Example
```yaml
name: Run Unit Tests
on: [push, pull_request]
jobs:
  test:
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v2
      - name: Run Unit Tests
        uses: game-ci/unity-test-runner@v2
        with:
          projectPath: GW2-Unity/GW2
          testMode: editmode
          unityVersion: 2022.3.0f1
```

## Adding New Tests

When implementing new domain classes:

1. Create `[ClassName]Tests.cs` in `Assets/Tests/Domain/`
2. Inherit from `MonoBehaviour` (optional) or use plain class
3. Use `[Test]` attribute for each test method
4. Follow naming: `[Feature]_[Condition]_[Expected]`

Example:
```csharp
[Test]
public void District_ProducedResource_SyncsToFactionProduces()
{
    var district = new District("Test", Vector3.zero);
    district.AddProducedResource("Gold", 30);
    
    Assert.AreEqual(1, district.Produces.Count);
    Assert.AreEqual("Gold", district.Produces[0].Name);
}
```

## Troubleshooting

### Tests Don't Appear in Test Runner
- Ensure `.asmdef` file exists: `Assets/Tests/Tests.asmdef`
- Check that test methods have `[Test]` attribute
- Rebuild the project: `Assets` → `Reimport All`

### "Assembly not found" Error
- Verify the asmdef references are correct
- Check project settings: `Edit` → `Project Settings` → `Player`
- Ensure Test Framework package is installed

### Tests Pass Locally but Fail in CI
- Check Unity version matches between local and CI
- Verify all dependencies are committed (no missing files)
- Check for platform-specific path issues (use `/` not `\`)

## Test Maintenance Schedule

- **After each domain model change**: Run tests immediately
- **Before committing**: Ensure all tests pass
- **During code review**: Check test coverage for new code
- **Weekly**: Review test results and update as needed

## Success Criteria

✅ All 66 tests pass
✅ No compilation warnings
✅ Code coverage > 95% for domain classes
✅ Tests run in < 2 seconds total
✅ No flaky or platform-dependent tests

---

**Last Updated**: 2026-04-05
**Next Review**: After any domain model changes

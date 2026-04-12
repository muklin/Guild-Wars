using UnityEngine;
using System.Collections.Generic;
using System.Linq;

/// <summary>
/// Session Zero Phase: Full city-creation flow before the game loop begins.
///
/// Step sequence (single-player MVP: 1 player + 2 NPC guilds):
///   1. Terrain Setup    — player places landscape features (NPCs auto-place)
///   2. District Setup   — reversed initiative: NPC2 → NPC1 → Player, cycling
///   3. HQ Placement     — player picks HQ district (NPCs auto-pick)
///   4. Guild Setup      — player creates guild/leader (NPC guilds auto-created)
/// </summary>
public class SessionZeroPhase : MonoBehaviour, IPhaseHandler
{
    // ─── Participant IDs ───────────────────────────────────────────────
    private const int PLAYER_ID = 1;
    private static readonly int[] NPC_IDS = { 2, 3 };
    // District turn order: reversed initiative (NPCs first, player last)
    private static readonly int[] DISTRICT_TURN_ORDER = { 3, 2, 1 };

    // ─── State ────────────────────────────────────────────────────────
    private GameStateManager gsm;
    private bool phaseComplete;

    public SessionZeroStep CurrentStep { get; private set; }
    private List<string> setupLog = new();

    // Terrain
    private int playerTerrainCount;

    // District setup
    private int currentTurnIndex;
    private bool[] passedThisRound;
    private int totalMaxDistricts;
    private Dictionary<int, int> npcDistrictQuota = new();
    private bool npcThreatPlaced;
    private int npcArchetypeIndex;
    private bool districtSetupComplete;

    // HQ
    private Dictionary<int, int> hqReservations = new(); // participantId → districtId

    // Guild setup
    public bool PlayerGuildCreated { get; private set; }

    // Public accessors for UI
    public List<string> SetupLog => new(setupLog);

    public bool IsPlayerTurn()
    {
        return CurrentStep switch
        {
            SessionZeroStep.Terrain      => playerTerrainCount == 0, // player must place at least 1
            SessionZeroStep.DistrictSetup => !districtSetupComplete && DISTRICT_TURN_ORDER[currentTurnIndex] == PLAYER_ID,
            SessionZeroStep.HQPlacement  => !hqReservations.ContainsKey(PLAYER_ID),
            SessionZeroStep.GuildSetup   => !PlayerGuildCreated,
            _                            => false
        };
    }

    // ─── IPhaseHandler ────────────────────────────────────────────────

    public void OnPhaseStart()
    {
        gsm = GameStateManager.Instance;
        phaseComplete = false;
        setupLog.Clear();
        playerTerrainCount = 0;
        npcArchetypeIndex = 0;
        npcThreatPlaced = false;
        hqReservations.Clear();
        PlayerGuildCreated = false;

        // District turn tracking
        passedThisRound = new bool[DISTRICT_TURN_ORDER.Length];
        currentTurnIndex = 0;
        npcDistrictQuota[2] = 2; // NPC1 places 2 districts
        npcDistrictQuota[3] = 2; // NPC2 places 2 districts + 1 threat
        totalMaxDistricts = 9;   // 3× participant count

        Log("=== SESSION ZERO BEGINS ===");
        Log("Step 1: Terrain Setup");
        Log("Describe the landscape surrounding the city (place at least one terrain feature).");
        SetStep(SessionZeroStep.Terrain);
        InitializeTerrainStep();
    }

    public void OnPhaseUpdate() { }

    public void OnPhaseEnd()
    {
        Log("Session Zero complete.");
        EventSystem.Instance?.Fire(GameEvents.SESSION_ZERO_END);
    }

    public bool IsPhaseComplete() => phaseComplete;
    public GamePhase GetPhaseType() => GamePhase.SessionZero;

    // ─── STEP 1: TERRAIN ──────────────────────────────────────────────

    /// <summary>Called by UI when the player places a terrain feature.</summary>
    public bool PlaceTerrainFeature(TerrainType type, string description, int gridX, int gridZ)
    {
        if (CurrentStep != SessionZeroStep.Terrain) return false;
        if (string.IsNullOrWhiteSpace(description)) { Log("Terrain requires a description."); return false; }

        var feature = new TerrainFeature(type, description, gridX, gridZ, PLAYER_ID);
        Object.FindAnyObjectByType<CityLayout>()?.AddTerrainFeature(feature);

        playerTerrainCount++;
        Log($"You placed terrain: {type} at ({gridX},{gridZ}) — \"{description}\"");
        EventSystem.Instance?.Fire(GameEvents.TERRAIN_PLACED);
        return true;
    }

    /// <summary>Called by UI when the player is done placing terrain (min 1 required).</summary>
    public bool FinishTerrainPlacement()
    {
        if (CurrentStep != SessionZeroStep.Terrain) return false;
        if (playerTerrainCount == 0) { Log("Place at least one terrain feature first."); return false; }

        Log("Terrain placement complete.");
        
        AdvanceToDistrictSetup();
        return true;
    }

    private void InitializeTerrainStep()
    {
        // Create Voronoi world generator on the CityVisualization GameObject
        var cityViz = Object.FindAnyObjectByType<CityVisualization>();
        if (cityViz == null)
        {
            Log("ERROR: CityVisualization not found. Cannot initialize terrain.");
            return;
        }

        var voronoiGen = cityViz.gameObject.AddComponent<VoronoiWorldGenerator>();
        voronoiGen.Generate();

        var mainCamera = Object.FindAnyObjectByType<Camera>();

        // Create terrain region selection controller
        var terrainController = cityViz.gameObject.AddComponent<TerrainSelectionController>();
        terrainController.Initialize(voronoiGen, this, mainCamera);
        terrainController.BeginTerrainSelection();

        // Create edge (cliff/river) selection controller
        var edgeController = cityViz.gameObject.AddComponent<EdgeSelectionController>();
        edgeController.Initialize(voronoiGen, this, mainCamera);
        // Don't start edge selection yet; user switches mode via UI

        // Create UI panel on the main canvas
        var mainCanvas = Object.FindAnyObjectByType<Canvas>();
        if (mainCanvas != null)
        {
            var panelGO = new GameObject("TerrainTypePanel");
            panelGO.transform.SetParent(mainCanvas.transform, false);
            var terrainPanel = panelGO.AddComponent<TerrainTypePanel>();
            terrainPanel.Initialize(terrainController, edgeController, this);
        }

        Log("Terrain setup initialized. Click regions and assign terrain types, or switch to edge mode for cliffs/rivers.");
    }

    // ─── STEP 2: DISTRICT SETUP ───────────────────────────────────────

    private void AdvanceToDistrictSetup()
    {
        currentTurnIndex = 0;
        for (int i = 0; i < passedThisRound.Length; i++) passedThisRound[i] = false;
        districtSetupComplete = false;

        Log("\nStep 2: District Setup");
        Log("Turn order (reversed initiative): NPC 2 → NPC 1 → You");
        Log("Each district starts producing 1 resource and consuming at least 3.");
        SetStep(SessionZeroStep.DistrictSetup);

        ProcessNPCDistrictTurns();
    }

    // Runs NPC turns until it becomes the player's turn (or setup ends).
    private void ProcessNPCDistrictTurns()
    {
        while (!districtSetupComplete && DISTRICT_TURN_ORDER[currentTurnIndex] != PLAYER_ID)
        {
            int npcId = DISTRICT_TURN_ORDER[currentTurnIndex];
            int turnIdx = currentTurnIndex;
            ExecuteNPCDistrictTurn(npcId, turnIdx);
            AdvanceDistrictTurn();
        }
    }

    private void ExecuteNPCDistrictTurn(int npcId, int turnIdx)
    {
        string npcName = NpcName(npcId);

        if (npcDistrictQuota.GetValueOrDefault(npcId, 0) > 0)
        {
            AutoPlaceNPCDistrict(npcId);
            npcDistrictQuota[npcId]--;
            passedThisRound[turnIdx] = false;

            // NPC2 places a threat on their last district turn
            if (npcId == 3 && npcDistrictQuota[3] == 0 && !npcThreatPlaced)
            {
                AutoPlaceNPCThreat();
                npcThreatPlaced = true;
            }
        }
        else
        {
            passedThisRound[turnIdx] = true;
            Log($"{npcName} passes.");
        }
    }

    private static readonly (string name, DistrictClass cls, string faction, string produces, string[] consumes)[]
        NPC_DISTRICT_ARCHETYPES =
    {
        ("Market District",  DistrictClass.Commerce,  "Merchants Guild",  "goods",       new[] { "gold",           "labor",    "food",    "transport"  }),
        ("Garrison Quarter", DistrictClass.Military,  "City Guard",       "protection",  new[] { "weapons",        "food",     "gold",    "lodging"    }),
        ("Temple District",  DistrictClass.Religious, "Holy Temples",     "blessings",   new[] { "incense",        "candles",  "gold",    "food"       }),
        ("Noble Quarter",    DistrictClass.Noble,     "Nobility",         "influence",   new[] { "fine_goods",     "servants", "gold",    "security"   }),
        ("The Warrens",      DistrictClass.Neutral,   "Common Folk",      "labor",       new[] { "food",           "water",    "shelter", "medicine"   }),
        ("Mages Quarter",    DistrictClass.Magical,   "Arcane Society",   "magic_items", new[] { "spell_components","books",   "gold",    "food"       }),
    };

    private void AutoPlaceNPCDistrict(int npcId)
    {
        var archetype = NPC_DISTRICT_ARCHETYPES[npcArchetypeIndex % NPC_DISTRICT_ARCHETYPES.Length];
        npcArchetypeIndex++;

        int count = gsm.GetAllDistricts().Count;
        var pos = new Vector3((count % 5) * 10f, 0, (count / 5) * 10f);
        var district = new District(archetype.name, pos);
        district.Class = archetype.cls;

        district.FactionLabel = archetype.faction;
        district.AddProducedResource(archetype.produces, 30);
        foreach (var c in archetype.consumes)
            district.AddConsumedResource(c, 10);

        WireAdjacency(district);
        gsm.AddDistrict(district);
        Log($"{NpcName(npcId)} placed district: {archetype.name} (produces {archetype.produces})");
    }

    private void AutoPlaceNPCThreat()
    {
        var threat = new Threat(
            "Bandits in the Surrounding Hills",
            "A growing band of outlaws threatening trade routes and outlying farms.",
            hp: 42, dc: 14,
            mitigationCriteria: "Defeat the bandit leader in a PvE encounter");
        threat.GridX = 4;
        threat.GridZ = 4;
        gsm.AddThreat(threat);
        Log("NPC 2 placed a threat: Bandits in the Surrounding Hills (DC 14)");
    }

    private void AdvanceDistrictTurn()
    {
        currentTurnIndex = (currentTurnIndex + 1) % DISTRICT_TURN_ORDER.Length;

        // Completed a full cycle
        if (currentTurnIndex == 0)
        {
            if (passedThisRound.All(p => p))
            {
                Log("All participants passed. District setup complete.");
                districtSetupComplete = true;
                AdvanceToHQPlacement();
                return;
            }
            // New cycle: reset pass flags
            for (int i = 0; i < passedThisRound.Length; i++) passedThisRound[i] = false;
        }

        if (gsm.GetAllDistricts().Count >= totalMaxDistricts)
        {
            Log($"Maximum districts ({totalMaxDistricts}) reached. District setup complete.");
            districtSetupComplete = true;
            AdvanceToHQPlacement();
        }
    }

    // ─── Player district actions ───

    /// <summary>Player places a district. consumedResources must have at least 3 non-empty entries.</summary>
    public bool PlaceDistrict(string name, DistrictClass districtClass, string factionName,
                              string producedResource, List<string> consumedResources,
                              int gridX, int gridZ, bool isWalled = false)
    {
        if (!CanPlayerActInDistrictSetup()) return false;
        if (string.IsNullOrWhiteSpace(name))           { Log("District needs a name.");              return false; }
        if (string.IsNullOrWhiteSpace(producedResource)) { Log("District needs a produced resource."); return false; }

        var validConsumes = consumedResources?.Where(r => !string.IsNullOrWhiteSpace(r)).ToList() ?? new();
        if (validConsumes.Count < 3) { Log("District must consume at least 3 resources."); return false; }
        if (gsm.GetAllDistricts().Count >= totalMaxDistricts) { Log("Maximum districts reached."); return false; }

        var pos = new Vector3(gridX * 10f, 0, gridZ * 10f);
        var district = new District(name, pos);
        district.Class = districtClass;
        district.IsWalled = isWalled;

        if (!string.IsNullOrWhiteSpace(factionName))
            district.FactionLabel = factionName;

        district.AddProducedResource(producedResource, 30);
        foreach (var c in validConsumes)
            district.AddConsumedResource(c, 10);

        WireAdjacency(district);
        gsm.AddDistrict(district);
        Log($"You placed district: {name} (produces {producedResource}, consumes {string.Join(", ", validConsumes)})");

        PlayerTookAction();
        return true;
    }

    /// <summary>Player places a threat on the map.</summary>
    public bool PlaceThreat(string name, string description, int dc, string mitigationCriteria,
                            int gridX, int gridZ)
    {
        if (!CanPlayerActInDistrictSetup()) return false;
        if (string.IsNullOrWhiteSpace(name)) { Log("Threat needs a name."); return false; }

        var threat = new Threat(name, description, hp: dc * 3, dc: dc, mitigationCriteria: mitigationCriteria);
        threat.GridX = gridX;
        threat.GridZ = gridZ;
        gsm.AddThreat(threat);
        Log($"You placed threat: {name} (DC {dc}) — \"{mitigationCriteria}\"");

        PlayerTookAction();
        return true;
    }

    /// <summary>Player adds an off-map trading destination.</summary>
    public bool AddTradingDestination(string name, List<string> produces, List<string> consumes)
    {
        if (!CanPlayerActInDistrictSetup()) return false;
        if (string.IsNullOrWhiteSpace(name)) { Log("Trading destination needs a name."); return false; }

        var dest = new TradingDestination(name);
        foreach (var r in produces.Where(r => !string.IsNullOrWhiteSpace(r))) dest.AddProducedResource(r);
        foreach (var r in consumes.Where(r => !string.IsNullOrWhiteSpace(r))) dest.AddConsumedResource(r);
        gsm.AddTradingDestination(dest);
        Log($"You added trading destination: {name}");

        PlayerTookAction();
        return true;
    }

    /// <summary>Records city leadership (informational only; does not consume a turn).</summary>
    public void DefineCityLeadership(string headOfState, string successionMethod)
    {
        if (string.IsNullOrWhiteSpace(gsm.GetCityLeaderName()))
        {
            gsm.SetCityLeadership(headOfState, successionMethod);
            Log($"City leadership defined: {headOfState} ({successionMethod})");
        }
        else
        {
            Log("City leadership is already defined.");
        }
    }

    /// <summary>Player passes their district setup turn.</summary>
    public void PassDistrictSetup()
    {
        if (!CanPlayerActInDistrictSetup()) return;
        int playerIdx = PlayerTurnIndex();
        passedThisRound[playerIdx] = true;
        Log("You pass.");
        AdvanceDistrictTurn();
        ProcessNPCDistrictTurns();
    }

    private void PlayerTookAction()
    {
        int playerIdx = PlayerTurnIndex();
        passedThisRound[playerIdx] = false;
        AdvanceDistrictTurn();
        ProcessNPCDistrictTurns();
    }

    private bool CanPlayerActInDistrictSetup() =>
        CurrentStep == SessionZeroStep.DistrictSetup
        && !districtSetupComplete
        && DISTRICT_TURN_ORDER[currentTurnIndex] == PLAYER_ID;

    private int PlayerTurnIndex()
    {
        for (int i = 0; i < DISTRICT_TURN_ORDER.Length; i++)
            if (DISTRICT_TURN_ORDER[i] == PLAYER_ID) return i;
        return -1;
    }

    // ─── STEP 3: HQ PLACEMENT ─────────────────────────────────────────

    private void AdvanceToHQPlacement()
    {
        Log("\nStep 3: Place Guild Headquarters");
        Log("Choose a district for your guild's headquarters (costs 1 Guild Token; grants +20 faction standing).");
        SetStep(SessionZeroStep.HQPlacement);
    }

    /// <summary>Player places their HQ in a district. NPCs auto-pick after.</summary>
    public bool PlacePlayerHQ(int districtId)
    {
        if (CurrentStep != SessionZeroStep.HQPlacement) return false;
        if (hqReservations.ContainsKey(PLAYER_ID)) return false;

        var district = gsm.GetDistrict(districtId);
        if (district == null) { Log("Invalid district."); return false; }

        hqReservations[PLAYER_ID] = districtId;
        Log($"Your HQ reserved in: {district.Name}");

        // NPC HQs: pick from remaining districts
        var remaining = gsm.GetAllDistricts()
            .Where(d => !hqReservations.Values.Contains(d.Id))
            .ToList();

        int idx = 0;
        foreach (int npcId in NPC_IDS)
        {
            if (idx < remaining.Count)
            {
                hqReservations[npcId] = remaining[idx].Id;
                Log($"{NpcName(npcId)} HQ reserved in: {remaining[idx].Name}");
                idx++;
            }
        }

        AdvanceToGuildSetup();
        return true;
    }

    // ─── STEP 4: GUILD SETUP ──────────────────────────────────────────

    private void AdvanceToGuildSetup()
    {
        Log("\nStep 4: Guild Setup");
        Log("Name your guild, introduce your leader (level 3) and second in command (level 1).");
        SetStep(SessionZeroStep.GuildSetup);
    }

    /// <summary>Player creates their guild. Triggers NPC guild creation and completes Session Zero.</summary>
    public bool CreatePlayerGuild(string guildName, string leaderName, string leaderClass,
                                  string secondName, string secondClass)
    {
        if (CurrentStep != SessionZeroStep.GuildSetup || PlayerGuildCreated) return false;
        if (string.IsNullOrWhiteSpace(guildName))  { Log("Enter a guild name.");  return false; }
        if (string.IsNullOrWhiteSpace(leaderName)) { Log("Enter a leader name."); return false; }

        var guild = new Guild(PLAYER_ID, guildName, PLAYER_ID);

        var leader = new GuildLeader(leaderName, leaderClass ?? "Fighter", level: 3, title: "Guild Leader");
        SetDefaultStats(leader, 12);
        guild.Leader = leader;
        guild.AddMember(leader);

        if (!string.IsNullOrWhiteSpace(secondName))
        {
            var second = new GuildLeader(secondName, secondClass ?? "Fighter", level: 1, title: "Second");
            SetDefaultStats(second, 10);
            guild.SecondInCommand = second;
            guild.AddMember(second);
        }

        gsm.AddGuild(guild);
        ApplyHQFactionStanding(PLAYER_ID);
        PlayerGuildCreated = true;

        Log($"Guild '{guildName}' created. Leader: {leaderName} (Level 3 {leaderClass ?? "Fighter"}).");
        if (!string.IsNullOrWhiteSpace(secondName))
            Log($"Second in command: {secondName} (Level 1 {secondClass ?? "Fighter"}).");

        CreateNPCGuilds();
        AdvanceToComplete();
        return true;
    }

    private void CreateNPCGuilds()
    {
        var npc1 = new Guild(2, "Iron Pact", 2);
        var npc1Leader = new GuildLeader("Commander Vael", "Fighter", 3, "Commander");
        npc1Leader.Strength = 16; npc1Leader.Constitution = 14; npc1Leader.Dexterity = 10;
        npc1Leader.Intelligence = 10; npc1Leader.Wisdom = 10; npc1Leader.Charisma = 10;
        npc1Leader.MaxHitPoints = 20; npc1Leader.HitPoints = 20;
        npc1.Leader = npc1Leader;
        npc1.AddMember(npc1Leader);
        npc1.AddMember(new GuildCharacter("Sergeant Bryn", "Fighter", 1));
        gsm.AddGuild(npc1);
        ApplyHQFactionStanding(2);
        Log("NPC Guild: Iron Pact created.");

        var npc2 = new Guild(3, "Shadow Web", 3);
        var npc2Leader = new GuildLeader("Mistress Kael", "Rogue", 3, "Spymistress");
        npc2Leader.Dexterity = 16; npc2Leader.Intelligence = 14; npc2Leader.Strength = 8;
        npc2Leader.Constitution = 10; npc2Leader.Wisdom = 12; npc2Leader.Charisma = 14;
        npc2Leader.MaxHitPoints = 20; npc2Leader.HitPoints = 20;
        npc2.Leader = npc2Leader;
        npc2.AddMember(npc2Leader);
        npc2.AddMember(new GuildCharacter("Scout Fen", "Rogue", 1));
        gsm.AddGuild(npc2);
        ApplyHQFactionStanding(3);
        Log("NPC Guild: Shadow Web created.");
    }

    private void ApplyHQFactionStanding(int guildId)
    {
        if (!hqReservations.TryGetValue(guildId, out int districtId)) return;
        var district = gsm.GetDistrict(districtId);
        if (district == null) return;
        // The district IS the faction — use its ID directly
        gsm.UpdateFactionStanding(guildId, district.Id, +20);
        Log($"Guild {guildId} gains +20 standing with {district.Name} (HQ bonus).");
    }

    private void AdvanceToComplete()
    {
        SetStep(SessionZeroStep.Complete);
        phaseComplete = true;
        Log($"\n=== SESSION ZERO COMPLETE ===");
        Log($"City: {gsm.GetAllDistricts().Count} districts | {gsm.GetAllThreats().Count} threats | {gsm.GetAllTradingDestinations().Count} trading destinations");
        Log("The game is ready to begin.");
    }

    // ─── TOKEN SPENDING ───────────────────────────────────────────────

    /// <summary>
    /// Spend a Guild Token. Actions: "round_token", "character_tokens", "triple_gold", "hire_recruits".
    /// </summary>
    public bool SpendGuildToken(int guildId, string action)
    {
        var guild = gsm.GetGuild(guildId);
        if (guild == null || guild.GuildTokens <= 0) { Log("No Guild Tokens remaining."); return false; }

        switch (action)
        {
            case "round_token":
                guild.GuildTokens--;
                guild.RoundTokens++;
                Log($"{guild.Name}: Guild Token → Round Token.");
                return true;
            case "character_tokens":
                guild.GuildTokens--;
                guild.CharacterTokens += 2;
                Log($"{guild.Name}: Guild Token → 2 Character Tokens.");
                return true;
            case "triple_gold":
                guild.GuildTokens--;
                guild.ReceiveMoney(guild.Gold * 2); // adds 2× existing → triples total
                Log($"{guild.Name}: tripled starting gold ({guild.Gold}gp).");
                return true;
            case "hire_recruits":
                guild.GuildTokens--;
                for (int i = 1; i <= 3; i++)
                    guild.AddMember(new GuildCharacter($"Recruit {i}", "Commoner", 0));
                Log($"{guild.Name}: hired 3 recruits.");
                return true;
            default:
                Log($"Unknown token action: {action}");
                return false;
        }
    }

    /// <summary>
    /// Spend Character Tokens to level up a character. Cost = target level.
    /// </summary>
    public bool SpendCharacterToken(int guildId, int characterId)
    {
        var guild = gsm.GetGuild(guildId);
        if (guild == null) { Log("Guild not found."); return false; }

        var character = guild.Members.FirstOrDefault(m => m.Id == characterId);
        if (character == null) { Log("Character not found."); return false; }

        int targetLevel = character.Level + 1;
        if (guild.CharacterTokens < targetLevel)
        {
            Log($"Need {targetLevel} Character Token(s) to reach level {targetLevel} (have {guild.CharacterTokens}).");
            return false;
        }

        guild.CharacterTokens -= targetLevel;
        character.Level = targetLevel;
        character.MaxHitPoints = 10 + (targetLevel - 1) * 5;
        character.HitPoints = character.MaxHitPoints;
        Log($"{guild.Name}: {character.Name} advanced to level {targetLevel} (spent {targetLevel} token(s)).");
        return true;
    }

    // ─── UTILITIES ────────────────────────────────────────────────────

    /// <summary>Wire simple linear adjacency: new district is adjacent to the last placed district.</summary>
    private void WireAdjacency(District newDistrict)
    {
        var all = gsm.GetAllDistricts();
        if (all.Count == 0) return;
        var prev = all[all.Count - 1];
        newDistrict.AddAdjacentDistrict(prev.Id);
        prev.AddAdjacentDistrict(newDistrict.Id);
    }

    private void SetStep(SessionZeroStep step)
    {
        CurrentStep = step;
        EventSystem.Instance?.Fire(GameEvents.SESSION_ZERO_STEP_CHANGED);
    }

    private void Log(string message)
    {
        setupLog.Add(message);
        Debug.Log($"[SessionZero] {message}");
    }

    private static string NpcName(int npcId) => npcId == 2 ? "NPC Guild 1" : "NPC Guild 2";

    private static void SetDefaultStats(GuildCharacter c, int statValue)
    {
        c.Strength = statValue; c.Dexterity = statValue; c.Constitution = statValue;
        c.Intelligence = statValue; c.Wisdom = statValue; c.Charisma = statValue;
    }
}

/// <summary>Steps within Session Zero.</summary>
public enum SessionZeroStep
{
    Terrain,
    DistrictSetup,
    HQPlacement,
    GuildSetup,
    Complete
}

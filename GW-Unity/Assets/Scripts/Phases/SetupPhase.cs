using UnityEngine;
using System.Collections.Generic;
using System.Linq;

/// <summary>
/// Setup Phase: Full city-creation flow before the game loop begins.
///
/// Step sequence (single-player MVP: 1 player + 2 NPC guilds):
///   1. Terrain Setup    — player places landscape features (NPCs auto-place)
///   2. District Setup   — reversed initiative: NPC2 → NPC1 → Player, cycling
///   3. HQ Placement     — player picks HQ district (NPCs auto-pick)
///   4. Guild Setup      — player creates guild/leader (NPC guilds auto-created)
/// </summary>
public class SetupPhase : MonoBehaviour, IPhaseHandler
{
    // ─── Participant IDs ───────────────────────────────────────────────
    private const int PLAYER_ID = 1;
    private static readonly int[] NPC_IDS = { 2, 3 };
    // District turn order: reversed initiative (NPCs first, player last)
    private static readonly int[] DISTRICT_TURN_ORDER = { 3, 2, 1 };

    // ─── State ────────────────────────────────────────────────────────
    private GameStateManager gsm;
    private bool phaseComplete;

    public SetupPhaseStep CurrentStep { get; private set; }
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
            SetupPhaseStep.Terrain => playerTerrainCount == 0, // player must place at least 1
            SetupPhaseStep.DistrictSetup => !districtSetupComplete && DISTRICT_TURN_ORDER[currentTurnIndex] == PLAYER_ID,
            SetupPhaseStep.HQPlacement => !hqReservations.ContainsKey(PLAYER_ID),
            SetupPhaseStep.GuildSetup => !PlayerGuildCreated,
            _ => false
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

        Log("=== Setup Phase BEGINS ===");
        Log("Step 1: Terrain Setup");
        Log("Describe the landscape surrounding the city (place at least one terrain feature).");
        InitializeTerrainStep();
        SetStep(SetupPhaseStep.Terrain);
    }

    public void OnPhaseUpdate() { }

    public void OnPhaseEnd()
    {
        Log("Setup Phase complete.");
        EventSystem.Instance?.Fire(GameEvents.SETUP_PHASE_END);
    }

    public bool IsPhaseComplete() => phaseComplete;
    public GamePhase GetPhaseType() => GamePhase.SetupPhase;

    // ─── STEP 1: TERRAIN ──────────────────────────────────────────────

    /// <summary>Called by UI when the player places a terrain feature.</summary>
    public bool PlaceTerrainFeature(TerrainType type, string description, int gridX, int gridZ)
    {
        if (CurrentStep != SetupPhaseStep.Terrain)
            return false;
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
        if (CurrentStep != SetupPhaseStep.Terrain)
            return false;
        if (playerTerrainCount == 0) { Log("Place at least one terrain feature first."); return false; }

        Log("Terrain placement complete.");

        InitializeCitySubdivisionStep();
        return true;
    }

    private void InitializeTerrainStep()
    {
        Debug.Log("[InitializeTerrainStep] Starting");
        // Create Voronoi world generator on the CityVisualization GameObject
        var cityViz = Object.FindAnyObjectByType<CityVisualization>();
        if (cityViz == null)
        {
            Log("ERROR: CityVisualization not found. Cannot initialize terrain.");
            return;
        }
        Debug.Log("[InitializeTerrainStep] CityVisualization found");

        var voronoiGen = cityViz.gameObject.AddComponent<VoronoiWorldGenerator>();
        voronoiGen.Generate();
        Debug.Log("[InitializeTerrainStep] VoronoiWorldGenerator created and generated");

        var mainCamera = Object.FindAnyObjectByType<Camera>();

        // Create UI panel on the main canvas FIRST so controllers can reference it
        var mainCanvasGO = GameObject.Find("MainCanvas");
        if (mainCanvasGO == null)
            throw new System.InvalidOperationException("MainCanvas GameObject not found in the scene!");
        Debug.Log("[InitializeTerrainStep] MainCanvas found");

        var mainCanvas = mainCanvasGO.GetComponent<Canvas>();
        if (mainCanvas == null)
            throw new System.InvalidOperationException("Canvas component not found on MainCanvas!");

        var panelGO = new GameObject("TerrainTypePanel");
        panelGO.transform.SetParent(mainCanvas.transform, false);
        Debug.Log("[InitializeTerrainStep] TerrainTypePanel GameObject created");
        panelGO.AddComponent<RectTransform>();  // Required for UI layout
        var terrainPanel = panelGO.AddComponent<TerrainTypePanel>();
        Debug.Log("[InitializeTerrainStep] TerrainTypePanel component added");

        // Create terrain region selection controller
        var terrainController = cityViz.gameObject.AddComponent<TerrainSelectionController>();
        terrainController.Initialize(voronoiGen, this, mainCamera, terrainPanel);
        terrainController.BeginTerrainSelection();
        Debug.Log("[InitializeTerrainStep] TerrainSelectionController created");

        // Create edge (cliff/river) selection controller
        var edgeController = cityViz.gameObject.AddComponent<EdgeSelectionController>();
        edgeController.Initialize(voronoiGen, this, mainCamera, terrainPanel);
        Debug.Log("[InitializeTerrainStep] EdgeSelectionController created");
        // Don't start edge selection yet; user switches mode via UI

        // Initialize the panel with both controllers
        terrainPanel.Initialize(terrainController, edgeController, this);
        Debug.Log("[InitializeTerrainStep] TerrainTypePanel initialized");

        // Show the panel immediately (it will also receive the step changed event)
        var canvasGroup = panelGO.GetComponent<CanvasGroup>();
        if (canvasGroup != null)
        {
            canvasGroup.alpha = 1f;
            canvasGroup.blocksRaycasts = true;
        }

        Log("Terrain setup initialized. Click regions and assign terrain types, or switch to edge mode for cliffs/rivers.");
        Debug.Log("[InitializeTerrainStep] COMPLETE - returning to OnPhaseStart");
    }

    // ─── STEP 1b: CITY SUBDIVISION ────────────────────────────────────

    private void InitializeCitySubdivisionStep()
    {
        Log("Step 1b: City Subdivision — generating district boundaries...");

        // 1. Retrieve the city region polygon
        var cityRegions = gsm.WorldTerrainData.GetRegionsByType(TerrainType.City);
        if (cityRegions.Count == 0) { Log("ERROR: City region not found."); return; }

        var cityRegion = cityRegions[0];
        var poly = cityRegion.Polygon;

        // 2. Compute bounding center and radius for camera focus
        var center = poly.Aggregate(Vector3.zero, (a, b) => a + b) / poly.Count;
        float radius = 0f;
        foreach (var v in poly) {
            float dist = Vector3.Distance(v, center);
            if (dist > radius) radius = dist;
        }

        // 3. Focus camera
        var cam = Object.FindAnyObjectByType<CameraController>();
        if (cam != null) {
            cam.FocusOn(center, radius);
            Log("Camera focused on city region.");
        }

        // 4. Create CityVoronoiGenerator on the CityVisualization GameObject
        var cityViz = Object.FindAnyObjectByType<CityVisualization>();
        if (cityViz == null) { Log("ERROR: CityVisualization not found."); return; }

        var cityGen = cityViz.gameObject.AddComponent<CityVoronoiGenerator>();
        cityGen.Generate(cityRegion.Polygon, 6);
        Log($"City subdivided into {gsm.CityDistrictData.DistrictCount} districts.");

        // 5. Create UI panel
        var mainCanvasGO = GameObject.Find("MainCanvas");
        if (mainCanvasGO == null) { Log("ERROR: MainCanvas not found."); return; }

        var mainCanvas = mainCanvasGO.GetComponent<Canvas>();
        if (mainCanvas == null) { Log("ERROR: Canvas not found on MainCanvas."); return; }

        var panelGO = new GameObject("DistrictTypePanel");
        panelGO.transform.SetParent(mainCanvas.transform, false);
        panelGO.AddComponent<RectTransform>();
        var districtPanel = panelGO.AddComponent<DistrictTypePanel>();

        // 6. Create selection controller
        var mainCamera = Object.FindAnyObjectByType<Camera>();
        var selController = cityViz.gameObject.AddComponent<CityDistrictSelectionController>();
        selController.Initialize(cityGen, this, mainCamera, districtPanel);
        selController.BeginDistrictSelection();
        Log("District selection controller initialized.");

        // 7. Initialize panel
        districtPanel.Initialize(selController, this);
        Log("District UI panel initialized.");

        // 8. Advance step
        SetStep(SetupPhaseStep.CitySubdivision);
    }

    /// <summary>Called by DistrictTypePanel when player finishes district classification.</summary>
    public bool FinishCitySubdivision()
    {
        if (CurrentStep != SetupPhaseStep.CitySubdivision)
            return false;

        Log("City subdivision complete. Advancing to district setup.");
        AdvanceToDistrictSetup();
        return true;
    }

    /// <summary>Called by selection controller to record a district classification.</summary>
    public void RecordDistrictClassAssignment(int districtId, DistrictClass cls)
    {
        Log($"District {districtId} classified as {cls}.");
    }

    // ─── STEP 2: DISTRICT SETUP ───────────────────────────────────────

    private void AdvanceToDistrictSetup()
    {
        currentTurnIndex = 0;
        for (int i = 0; i < passedThisRound.Length; i++)
            passedThisRound[i] = false;
        districtSetupComplete = false;

        Log("\nStep 2: District Setup");
        Log("Turn order (reversed initiative): NPC 2 → NPC 1 → You");
        Log("Each district starts producing 1 resource and consuming at least 3.");
        SetStep(SetupPhaseStep.DistrictSetup);

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
            for (int i = 0; i < passedThisRound.Length; i++)
                passedThisRound[i] = false;
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
        if (!CanPlayerActInDistrictSetup())
            return false;
        if (string.IsNullOrWhiteSpace(name)) { Log("District needs a name."); return false; }
        if (string.IsNullOrWhiteSpace(producedResource)) { Log("District needs a produced resource."); return false; }

        var validConsumes = consumedResources?.Where(r => !string.IsNullOrWhiteSpace(r)).ToList() ?? new();
        if (validConsumes.Count < 3) { Log("District must consume at least 3 resources."); return false; }
        if (gsm.GetAllDistricts().Count >= totalMaxDistricts) { Log("Maximum districts reached."); return false; }

        var pos = new Vector3(gridX * 10f, 0, gridZ * 10f);
        var district = new District(name, pos);
        district.Class = districtClass;

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
        if (!CanPlayerActInDistrictSetup())
            return false;
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
        if (!CanPlayerActInDistrictSetup())
            return false;
        if (string.IsNullOrWhiteSpace(name)) { Log("Trading destination needs a name."); return false; }

        var dest = new TradingDestination(name);
        foreach (var r in produces.Where(r => !string.IsNullOrWhiteSpace(r)))
            dest.AddProducedResource(r);
        foreach (var r in consumes.Where(r => !string.IsNullOrWhiteSpace(r)))
            dest.AddConsumedResource(r);
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
        if (!CanPlayerActInDistrictSetup())
            return;
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
        CurrentStep == SetupPhaseStep.DistrictSetup
        && !districtSetupComplete
        && DISTRICT_TURN_ORDER[currentTurnIndex] == PLAYER_ID;

    private int PlayerTurnIndex()
    {
        for (int i = 0; i < DISTRICT_TURN_ORDER.Length; i++)
            if (DISTRICT_TURN_ORDER[i] == PLAYER_ID)
                return i;
        return -1;
    }

    // ─── STEP 3: HQ PLACEMENT ─────────────────────────────────────────

    private void AdvanceToHQPlacement()
    {
        Log("\nStep 3: Place Guild Headquarters");
        Log("Choose a district for your guild's headquarters (costs 1 Guild Token; grants +20 faction standing).");
        SetStep(SetupPhaseStep.HQPlacement);
    }

    /// <summary>Player places their HQ in a district. NPCs auto-pick after.</summary>
    public bool PlacePlayerHQ(int districtId)
    {
        if (CurrentStep != SetupPhaseStep.HQPlacement)
            return false;
        if (hqReservations.ContainsKey(PLAYER_ID))
            return false;

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
        SetStep(SetupPhaseStep.GuildSetup);
    }

    /// <summary>Player creates their guild. Triggers NPC guild creation and completes Setup Phase.</summary>
    public bool CreatePlayerGuild(string guildName, string leaderName, string leaderClass,
                                  string secondName, string secondClass)
    {
        if (CurrentStep != SetupPhaseStep.GuildSetup || PlayerGuildCreated)
            return false;
        if (string.IsNullOrWhiteSpace(guildName)) { Log("Enter a guild name."); return false; }
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
        npc1Leader.Strength = 16;
        npc1Leader.Constitution = 14;
        npc1Leader.Dexterity = 10;
        npc1Leader.Intelligence = 10;
        npc1Leader.Wisdom = 10;
        npc1Leader.Charisma = 10;
        npc1Leader.MaxHitPoints = 20;
        npc1Leader.HitPoints = 20;
        npc1.Leader = npc1Leader;
        npc1.AddMember(npc1Leader);
        npc1.AddMember(new GuildCharacter("Sergeant Bryn", "Fighter", 1));
        gsm.AddGuild(npc1);
        ApplyHQFactionStanding(2);
        Log("NPC Guild: Iron Pact created.");

        var npc2 = new Guild(3, "Shadow Web", 3);
        var npc2Leader = new GuildLeader("Mistress Kael", "Rogue", 3, "Spymistress");
        npc2Leader.Dexterity = 16;
        npc2Leader.Intelligence = 14;
        npc2Leader.Strength = 8;
        npc2Leader.Constitution = 10;
        npc2Leader.Wisdom = 12;
        npc2Leader.Charisma = 14;
        npc2Leader.MaxHitPoints = 20;
        npc2Leader.HitPoints = 20;
        npc2.Leader = npc2Leader;
        npc2.AddMember(npc2Leader);
        npc2.AddMember(new GuildCharacter("Scout Fen", "Rogue", 1));
        gsm.AddGuild(npc2);
        ApplyHQFactionStanding(3);
        Log("NPC Guild: Shadow Web created.");
    }

    private void ApplyHQFactionStanding(int guildId)
    {
        if (!hqReservations.TryGetValue(guildId, out int districtId))
            return;
        var district = gsm.GetDistrict(districtId);
        if (district == null)
            return;
        // The district IS the faction — use its ID directly
        gsm.UpdateFactionStanding(guildId, district.Id, +20);
        Log($"Guild {guildId} gains +20 standing with {district.Name} (HQ bonus).");
    }

    private void AdvanceToComplete()
    {
        SetStep(SetupPhaseStep.Complete);
        phaseComplete = true;
        Log($"\n=== Setup Phase COMPLETE ===");
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
        if (all.Count == 0)
            return;
        var prev = all[all.Count - 1];
        newDistrict.AddAdjacentDistrict(prev.Id);
        prev.AddAdjacentDistrict(newDistrict.Id);
    }

    private void SetStep(SetupPhaseStep step)
    {
        Debug.Log($"[SetStep] Setting step to {step}");
        CurrentStep = step;
        Debug.Log($"[SetStep] Firing SETUP_PHASE_STEP_CHANGED event with step={step}");
        EventSystem.Instance?.Fire<SetupPhaseStep>(GameEvents.SETUP_PHASE_STEP_CHANGED, step);
        Debug.Log($"[SetStep] Event fired");
    }

    private void Log(string message)
    {
        setupLog.Add(message);
        Debug.Log($"[SetupPhase] {message}");
    }

    private static string NpcName(int npcId) => npcId == 2 ? "NPC Guild 1" : "NPC Guild 2";

    private static void SetDefaultStats(GuildCharacter c, int statValue)
    {
        c.Strength = statValue;
        c.Dexterity = statValue;
        c.Constitution = statValue;
        c.Intelligence = statValue;
        c.Wisdom = statValue;
        c.Charisma = statValue;
    }
}

/// <summary>Steps within Setup Phase.</summary>
public enum SetupPhaseStep
{
    Terrain,
    CitySubdivision,
    DistrictSetup,
    HQPlacement,
    GuildSetup,
    Complete
}

using UnityEngine;

/// <summary>
/// Manages the one-time Setup Phase flow, separate from the repeating game loop.
/// Owns and drives SetupPhase; fires SETUP_PHASE_END when complete, at which point
/// GamePhaseManager takes over with the normal Upkeep → Planning → Execution → Bills cycle.
/// </summary>
public class SetupPhaseManager : MonoBehaviour {
    public static SetupPhaseManager Instance { get; private set; }

    private SetupPhase phase;
    private bool completed;
    private CityVisualization cityViz;
    private CityLayout cityLayout;
    private BuildingSpawner buildingSpawner;


    public SetupPhase Phase => phase;
    public bool IsComplete => completed;
    public CityVisualization CityViz => cityViz;
    public BuildingSpawner BuildingSpawner => buildingSpawner;

    private void Awake() {
        if (Instance != null && Instance != this) {
            Destroy(gameObject);
            return;
        }
        Instance = this;
        DontDestroyOnLoad(gameObject);

        phase = gameObject.AddComponent<SetupPhase>();



        // Spawn an empty city grid now so it is visible during Setup Phase.
        //    Districts and terrain are added incrementally as the player builds the world.
        SpawnCityVisualization();

        // Subscribe to district/terrain events so the view refreshes in real time.
        EventSystem.Instance?.Subscribe(GameEvents.DISTRICT_CREATED, OnDistrictCreated);
        EventSystem.Instance?.Subscribe(GameEvents.TERRAIN_PLACED, OnTerrainPlaced);

    }

    private void Update() {
        if (completed || phase == null)
            return;

        phase.OnPhaseUpdate();

        if (phase.IsPhaseComplete()) {
            completed = true;
            phase.OnPhaseEnd(); // fires SETUP_PHASE_END
        }
    }

    /// <summary>
    /// Starts Setup Phase. Call this from GameBootstrapper instead of GamePhaseManager.BeginRound().
    /// </summary>
    public void Begin() {
        if (completed) {
            Debug.LogWarning("[SetupPhaseManager] Setup Phase already completed.");
            return;
        }

        Debug.Log("[SetupPhaseManager] Begin() called");
        GameStateManager.Instance?.SetCurrentPhase(GamePhase.SetupPhase);
        Debug.Log("[SetupPhaseManager] Calling phase.OnPhaseStart()");
        phase.OnPhaseStart();
        Debug.Log($"[SetupPhaseManager] Firing event: {GameEvents.SETUP_PHASE_START}");
        EventSystem.Instance?.Fire<object>(GameEvents.SETUP_PHASE_START, null);
        Debug.Log("[SetupPhaseManager] Event fired");
    }
    // ─── City visualisation ───────────────────────────────────────────────────

    private void SpawnCityVisualization() {
        var cityGO = new GameObject("CityVisualization");
        cityViz = cityGO.AddComponent<CityVisualization>();
        cityLayout = cityGO.AddComponent<CityLayout>();
        buildingSpawner = cityGO.AddComponent<BuildingSpawner>();
        buildingSpawner.Initialize();

        // Layout starts empty; grid fills as districts are added during Setup Phase.
        var districts = GameStateManager.Instance?.GetAllDistricts();
        if (districts.Count > 0) {
            cityLayout.GenerateGridLayout(districts);
            foreach (var d in districts)
                buildingSpawner.SpawnDistrictVisual(d);
        }

        Debug.Log("[GameBootstrapper] City visualisation ready.");
    }

    private void OnDistrictCreated() {
        // Regenerate the grid layout and spawn a visual for the newly added district.
        var districts = GameStateManager.Instance?.GetAllDistricts();
        cityLayout.GenerateGridLayout(districts);
        if (districts.Count > 0) {
            buildingSpawner.SpawnDistrictVisual(districts[districts.Count - 1]);

        }
    }

    private void OnTerrainPlaced() {
        // Terrain features are stored in CityLayout; visual refresh can be wired here
        // once terrain visuals are implemented (post-MVP).
        Debug.Log("[GameBootstrapper] Terrain placed — visualisation update pending.");
    }

}

using UnityEngine;

/// <summary>
/// Manages the one-time Session Zero setup flow, separate from the repeating game loop.
/// Owns and drives SessionZeroPhase; fires SESSION_ZERO_END when complete, at which point
/// GamePhaseManager takes over with the normal Upkeep → Planning → Execution → Bills cycle.
/// </summary>
public class SessionZeroManager : MonoBehaviour {
    public static SessionZeroManager Instance { get; private set; }

    private SessionZeroPhase phase;
    private bool completed;
    private CityVisualization cityViz;
    private CityLayout cityLayout;
    private BuildingSpawner buildingSpawner;


    public SessionZeroPhase Phase => phase;
    public bool IsComplete => completed;

    private void Awake() {
        if (Instance != null && Instance != this) {
            Destroy(gameObject);
            return;
        }
        Instance = this;
        DontDestroyOnLoad(gameObject);

        phase = gameObject.AddComponent<SessionZeroPhase>();



        // Spawn an empty city grid now so it is visible during Session Zero.
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
            phase.OnPhaseEnd(); // fires SESSION_ZERO_END
        }
    }

    /// <summary>
    /// Starts Session Zero. Call this from GameBootstrapper instead of GamePhaseManager.BeginRound().
    /// </summary>
    public void Begin() {
        if (completed) {
            Debug.LogWarning("[SessionZeroManager] Session Zero already completed.");
            return;
        }

        GameStateManager.Instance?.SetCurrentPhase(GamePhase.SessionZero);
        phase.OnPhaseStart();
        EventSystem.Instance?.Fire(GameEvents.SESSION_ZERO_START);
    }
    // ─── City visualisation ───────────────────────────────────────────────────

    private void SpawnCityVisualization() {
        var cityGO = new GameObject("CityVisualization");
        cityViz = cityGO.AddComponent<CityVisualization>();
        cityLayout = cityGO.AddComponent<CityLayout>();
        buildingSpawner = cityGO.AddComponent<BuildingSpawner>();
        buildingSpawner.Initialize();

        // Layout starts empty; grid fills as districts are added during Session Zero.
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

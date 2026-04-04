using UnityEngine;

/// <summary>
/// Initialises core managers at startup, then hands off to SessionZeroManager.
/// City visualisation is created immediately (empty grid) so players can see the map
/// during Session Zero as they place terrain and districts.
/// When Session Zero ends, GamePhaseManager starts the repeating game loop.
/// </summary>
public class GameBootstrapper : MonoBehaviour
{
    private GameStateManager gameStateManager;
    private GamePhaseManager gamePhaseManager;
    private CityVisualization cityViz;
    private CityLayout cityLayout;
    private BuildingSpawner buildingSpawner;

    private void Start()
    {
        // 1. Core managers
        gameStateManager = FindOrCreate<GameStateManager>("GameStateManager");
        FindOrCreate<EventSystem>("EventSystem");
        gamePhaseManager = FindOrCreate<GamePhaseManager>("GamePhaseManager");
        FindOrCreate<UIManager>("UIManager");
        FindOrCreate<SessionZeroManager>("SessionZeroManager");

        // 2. Spawn an empty city grid now so it is visible during Session Zero.
        //    Districts and terrain are added incrementally as the player builds the world.
        SpawnCityVisualization();

        // 3. Subscribe to district/terrain events so the view refreshes in real time.
        EventSystem.Instance?.Subscribe(GameEvents.DISTRICT_CREATED,  OnDistrictCreated);
        EventSystem.Instance?.Subscribe(GameEvents.TERRAIN_PLACED,    OnTerrainPlaced);

        // 4. When Session Zero finishes, hand off to the game loop.
        EventSystem.Instance?.Subscribe(GameEvents.SESSION_ZERO_END, OnSessionZeroComplete);

        // 5. Begin Session Zero.
        SessionZeroManager.Instance.Begin();

        Debug.Log("=== Bootstrap complete — Session Zero started ===");
    }

    // ─── City visualisation ───────────────────────────────────────────────────

    private void SpawnCityVisualization()
    {
        var cityGO  = new GameObject("CityVisualization");
        cityViz     = cityGO.AddComponent<CityVisualization>();
        cityLayout  = cityGO.AddComponent<CityLayout>();
        buildingSpawner = cityGO.AddComponent<BuildingSpawner>();
        buildingSpawner.Initialize();

        // Layout starts empty; grid fills as districts are added during Session Zero.
        var districts = gameStateManager.GetAllDistricts();
        if (districts.Count > 0)
        {
            cityLayout.GenerateGridLayout(districts);
            foreach (var d in districts)
                buildingSpawner.SpawnDistrictVisual(d);
        }

        Debug.Log("[GameBootstrapper] City visualisation ready.");
    }

    private void OnDistrictCreated()
    {
        // Regenerate the grid layout and spawn a visual for the newly added district.
        var districts = gameStateManager.GetAllDistricts();
        cityLayout.GenerateGridLayout(districts);
        if (districts.Count > 0)
        {
            buildingSpawner.SpawnDistrictVisual(districts[districts.Count - 1]);
            cityViz.SetOrbitCenter(districts[0].WorldPosition);
        }
    }

    private void OnTerrainPlaced()
    {
        // Terrain features are stored in CityLayout; visual refresh can be wired here
        // once terrain visuals are implemented (post-MVP).
        Debug.Log("[GameBootstrapper] Terrain placed — visualisation update pending.");
    }

    // ─── Session Zero → Game Loop hand-off ───────────────────────────────────

    private void OnSessionZeroComplete()
    {
        Debug.Log("[GameBootstrapper] Session Zero complete — starting game loop.");
        gamePhaseManager.BeginRound();
    }

    // ─── Utility ─────────────────────────────────────────────────────────────

    private static T FindOrCreate<T>(string goName) where T : Component
    {
        var existing = Object.FindAnyObjectByType<T>();
        if (existing != null) return existing;
        return new GameObject(goName).AddComponent<T>();
    }
}

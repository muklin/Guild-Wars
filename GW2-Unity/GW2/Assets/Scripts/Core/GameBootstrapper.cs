using UnityEngine;
using System.Collections.Generic;

/// <summary>
/// Initializes the game at startup. Creates core managers and starts Session Zero.
/// All world and guild creation is handled by SessionZeroPhase.
/// City visualization is spawned after Session Zero completes.
/// </summary>
public class GameBootstrapper : MonoBehaviour
{
    private GameStateManager gameStateManager;
    private GamePhaseManager gamePhaseManager;

    private void Start()
    {
        InitializeGame();
    }

    private void InitializeGame()
    {
        Debug.Log("=== GuildWars Bootstrapping ===");

        // Create core managers (find existing in scene or create new)
        gameStateManager = FindOrCreate<GameStateManager>("GameStateManager");
        FindOrCreate<EventSystem>("EventSystem");
        gamePhaseManager = FindOrCreate<GamePhaseManager>("GamePhaseManager");
        FindOrCreate<UIManager>("UIManager");

        // City visualization spawns after Session Zero completes (world is built by then)
        EventSystem.Instance?.Subscribe(GameEvents.SESSION_ZERO_END, OnSessionZeroComplete);

        // Start the game — Session Zero handles all world/guild creation
        gamePhaseManager.BeginRound();

        Debug.Log("=== Bootstrap Complete — Session Zero started ===");
    }

    private void OnSessionZeroComplete()
    {
        Debug.Log("[GameBootstrapper] Session Zero complete — building city visualization.");
        SpawnCityVisualization();
    }

    private void SpawnCityVisualization()
    {
        var districts = gameStateManager.GetAllDistricts();
        if (districts.Count == 0)
        {
            Debug.LogWarning("[GameBootstrapper] No districts to visualize.");
            return;
        }

        var cityGO = new GameObject("CityVisualization");
        var cityViz    = cityGO.AddComponent<CityVisualization>();
        var cityLayout = cityGO.AddComponent<CityLayout>();
        var spawner    = cityGO.AddComponent<BuildingSpawner>();

        spawner.Initialize();
        cityLayout.GenerateGridLayout(districts);

        foreach (var district in districts)
            spawner.SpawnDistrictVisual(district);

        cityViz.SetOrbitCenter(districts[0].WorldPosition);

        Debug.Log($"[GameBootstrapper] City visualization complete ({districts.Count} districts).");
    }

    private static T FindOrCreate<T>(string goName) where T : Component
    {
        var existing = Object.FindAnyObjectByType<T>();
        if (existing != null) return existing;
        return new GameObject(goName).AddComponent<T>();
    }
}

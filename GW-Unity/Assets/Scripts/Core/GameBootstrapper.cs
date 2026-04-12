using UnityEngine;

/// <summary>
/// Initialises core managers at startup, then hands off to SessionZeroManager.
/// City visualisation is created immediately (empty grid) so players can see the map
/// during Session Zero as they place terrain and districts.
/// When Session Zero ends, GamePhaseManager starts the repeating game loop.
/// </summary>
public class GameBootstrapper : MonoBehaviour {
    private GameStateManager gameStateManager;
    private GamePhaseManager gamePhaseManager;

    private void Start() {
        // 0. Set up camera (must be done before anything else that might use it)
        SetupCamera();

        // 1. Core managers
        gameStateManager = FindOrCreate<GameStateManager>("GameStateManager");
        FindOrCreate<EventSystem>("EventSystem");
        gamePhaseManager = FindOrCreate<GamePhaseManager>("GamePhaseManager");
        FindOrCreate<UIManager>("UIManager");
        FindOrCreate<SessionZeroManager>("SessionZeroManager");


        // 4. When Session Zero finishes, hand off to the game loop.
        EventSystem.Instance?.Subscribe(GameEvents.SESSION_ZERO_END, OnSessionZeroComplete);

        // 5. Begin Session Zero.
        SessionZeroManager.Instance.Begin();

        Debug.Log("=== Bootstrap complete — Session Zero started ===");
    }

    // ─── Camera Setup ─────────────────────────────────────────────────────────

    private void SetupCamera() {
        // Delete all existing cameras
        var existingCameras = Object.FindObjectsByType<Camera>();
        foreach (var cam in existingCameras) {
            Debug.Log($"[GameBootstrapper] Destroying existing camera: {cam.name}");
            Object.Destroy(cam.gameObject);
        }

        // Create new camera with isometric orthographic view
        var cameraGO = new GameObject("MainCamera");
        var camera = cameraGO.AddComponent<Camera>();

        // Set up CameraController to let Player control camera movement.
        cameraGO.AddComponent<CameraController>();

        // Add AudioListener for sound
        cameraGO.AddComponent<AudioListener>();

        Debug.Log("[GameBootstrapper] Camera setup complete — isometric orthographic view.");
    }


    // ─── Session Zero → Game Loop hand-off ───────────────────────────────────

    private void OnSessionZeroComplete() {
        Debug.Log("[GameBootstrapper] Session Zero complete — starting game loop.");
        gamePhaseManager.BeginRound();
    }

    // ─── Utility ─────────────────────────────────────────────────────────────

    private static T FindOrCreate<T>(string goName) where T : Component {
        var existing = Object.FindAnyObjectByType<T>();
        if (existing != null)
            return existing;
        return new GameObject(goName).AddComponent<T>();
    }
}

using UnityEngine;

/// <summary>
/// Initialises core managers at startup, then hands off to SetupPhaseManager.
/// City visualisation is created immediately (empty grid) so players can see the map
/// during Setup Phase as they place terrain and districts.
/// When Setup Phase ends, GamePhaseManager starts the repeating game loop.
/// </summary>
public class GameBootstrapper : MonoBehaviour {
    private GameStateManager gameStateManager;
    private GamePhaseManager gamePhaseManager;

    private void Start() {
        // 0. Set up camera (must be done before anything else that might use it)
        SetupCamera();

        // 1. Core managers

        var eventSystem = FindOrCreate<EventSystem>("EventSystem");
        var uiManager = FindOrCreate<UIManager>("UIManager");
        gameStateManager = FindOrCreate<GameStateManager>("GameStateManager");
        gamePhaseManager = FindOrCreate<GamePhaseManager>("GamePhaseManager");
        var setupManager = FindOrCreate<SetupPhaseManager>("SetupPhaseManager");

        // 2. Ensure UI is fully initialized before Setup Phase starts (it needs MainCanvas)
        uiManager.EnsureInitialized();

        // 3. When Setup Phase finishes, hand off to the game loop.
        EventSystem.Instance?.Subscribe(GameEvents.SETUP_PHASE_END, OnSetupPhaseComplete);

        // 4. Begin Setup Phase.
        SetupPhaseManager.Instance.Begin();

        Debug.Log("=== Bootstrap complete — Setup Phase started ===");
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


    // ─── Setup Phase → Game Loop hand-off ───────────────────────────────────

    private void OnSetupPhaseComplete() {
        Debug.Log("[GameBootstrapper] Setup Phase complete — starting game loop.");
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

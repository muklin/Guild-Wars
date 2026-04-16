using UnityEngine;
using System.Collections.Generic;

/// <summary>
/// Orchestrates the turn flow: SetupPhase (setup) → Upkeep → Planning → Execution → Bills
/// Broadcasts phase transitions to all clients via networking.
/// Manages phase timeouts and auto-advance logic.
/// </summary>
public class GamePhaseManager : MonoBehaviour {
    public static GamePhaseManager Instance { get; private set; }

    [SerializeField] private float planningPhaseDurationSeconds = 900f; // 15 minutes

    private GameStateManager gameStateManager;
    private Dictionary<GamePhase, IPhaseHandler> phaseHandlers = new();
    private IPhaseHandler currentPhaseHandler;

    private float phaseTimer = 0f;
    private bool isPhaseActive = false;

    private void Awake() {
        if (Instance != null && Instance != this) {
            Destroy(gameObject);
            return;
        }
        Instance = this;
        DontDestroyOnLoad(gameObject);

        gameStateManager = GameStateManager.Instance;
        if (gameStateManager == null) {
            Debug.LogError("[GamePhaseManager] GameStateManager not found!");
            return;
        }

        // Initialize phase handlers EARLY so BeginRound() can use them
        InitializePhaseHandlers();
    }

    private void Start() {
        // Phase handlers already initialized in Awake
    }

    private void InitializePhaseHandlers() {
        // Setup Phase is managed separately by SetupPhaseManager.
        // GamePhaseManager only owns the repeating game loop phases.
        phaseHandlers[GamePhase.Upkeep] = gameObject.AddComponent<UpkeepPhase>();
        phaseHandlers[GamePhase.Planning] = gameObject.AddComponent<PlanningPhase>();
        phaseHandlers[GamePhase.Execution] = gameObject.AddComponent<ExecutionPhase>();
        phaseHandlers[GamePhase.Bills] = gameObject.AddComponent<BillsPhase>();

        Debug.Log("[GamePhaseManager] Phase handlers initialized (Upkeep → Planning → Execution → Bills)");
    }

    private void Update() {
        if (!isPhaseActive || currentPhaseHandler == null)
            return;

        currentPhaseHandler.OnPhaseUpdate();

        // Check for phase completion
        if (currentPhaseHandler.IsPhaseComplete()) {
            AdvancePhase();
        }

        // Planning phase has a timeout
        if (gameStateManager.GetCurrentPhase() == GamePhase.Planning) {
            phaseTimer += Time.deltaTime;
            if (phaseTimer >= planningPhaseDurationSeconds) {
                Debug.Log("Planning phase timeout - advancing to execution");
                AdvancePhase();
            }
        }
    }

    // ==================== PHASE MANAGEMENT ====================

    public void BeginRound() {
        if (isPhaseActive) {
            Debug.LogWarning("[GamePhaseManager] Round already in progress");
            return;
        }

        if (phaseHandlers.Count == 0) {
            Debug.LogError("[GamePhaseManager] Phase handlers not initialized!");
            return;
        }

        if (gameStateManager == null) {
            Debug.LogError("[GamePhaseManager] GameStateManager not initialized!");
            return;
        }

        isPhaseActive = true;
        Debug.Log("[GamePhaseManager] Starting game loop (Setup Phase already complete).");
        StartPhase(GamePhase.Upkeep);
    }

    private void StartPhase(GamePhase phase) {
        if (!phaseHandlers.TryGetValue(phase, out var handler)) {
            Debug.LogError($"No handler found for phase: {phase}");
            return;
        }

        // End current phase
        if (currentPhaseHandler != null) {
            currentPhaseHandler.OnPhaseEnd();
        }

        // Start new phase
        currentPhaseHandler = handler;
        gameStateManager.SetCurrentPhase(phase);
        phaseTimer = 0f;
        currentPhaseHandler.OnPhaseStart();

        // Fire event
        EventSystem.Instance?.Fire(GameEvents.PHASE_CHANGED, phase);
        Debug.Log($"Phase started: {phase}");
    }

    private void AdvancePhase() {
        GamePhase nextPhase = gameStateManager.GetCurrentPhase() switch {
            GamePhase.Upkeep => GamePhase.Planning,
            GamePhase.Planning => GamePhase.Execution,
            GamePhase.Execution => GamePhase.Bills,
            GamePhase.Bills => GamePhase.Upkeep,
            _ => GamePhase.Upkeep
        };

        if (nextPhase == GamePhase.Upkeep) // Bills → Upkeep means a round just ended
        {
            gameStateManager.AdvanceRound();
            CheckVictoryConditions();

            if (gameStateManager.IsGameComplete()) {
                EndGame();
                return;
            }
        }

        StartPhase(nextPhase);
    }

    private void CheckVictoryConditions() {
        var config = Resources.Load<GameConfig>("GameConfig");
        if (config == null) {
            Debug.LogWarning("GameConfig not found in Resources folder");
            return;
        }

        int victoryThreshold = config.VictoryFactionStanding;

        // Check all factions for each guild
        foreach (var guild in gameStateManager.GetAllGuilds()) {
            foreach (var faction in gameStateManager.GetAllFactions()) {
                int standing = guild.GetFactionStanding(faction.Id);
                if (standing >= victoryThreshold) {
                    Debug.Log($"Guild {guild.Name} has reached {standing} standing with {faction.Name}! VICTORY!");
                    return;
                }
            }
        }
    }

    private void EndGame() {
        isPhaseActive = false;
        EventSystem.Instance?.Fire(GameEvents.GAME_ENDED);
        Debug.Log("Game ended!");
    }

    // ==================== GETTERS ====================

    public GamePhase GetCurrentPhase() {
        return gameStateManager.GetCurrentPhase();
    }

    public IPhaseHandler GetPhaseHandler(GamePhase phase) {
        phaseHandlers.TryGetValue(phase, out var handler);
        return handler;
    }

    public float GetPlanningPhaseTimeRemaining() {
        if (gameStateManager.GetCurrentPhase() != GamePhase.Planning)
            return 0f;
        return Mathf.Max(0, planningPhaseDurationSeconds - phaseTimer);
    }
}

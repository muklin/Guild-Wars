using UnityEngine;
using UnityEngine.UI;
using UnityEngine.InputSystem.UI;
using System.Collections.Generic;

/// <summary>
/// Central UI manager for GuildWars.
/// Manages all UI panels, subscriptions to game events, and state display.
/// Implements Singleton pattern.
/// </summary>
public class UIManager : MonoBehaviour {
    public static UIManager Instance { get; private set; }

    private Dictionary<string, UIPanel> panels = new();
    private Canvas mainCanvas;

    private void Awake() {
        if (Instance != null && Instance != this) {
            Destroy(gameObject);
            return;
        }
        Instance = this;
        DontDestroyOnLoad(gameObject);
    }

    private bool isInitialized = false;

    private void Start() {
        EnsureInitialized();
    }

    public void EnsureInitialized() {
        if (isInitialized)
            return;

        // Create main canvas if it doesn't exist
        mainCanvas = Object.FindAnyObjectByType<Canvas>();
        if (mainCanvas == null) {
            CreateMainCanvas();
        }

        // Initialize all UI panels
        InitializePanels();

        // Subscribe to game events
        SubscribeToGameEvents();

        isInitialized = true;
    }

    private void CreateMainCanvas() {
        var canvasObj = new GameObject("MainCanvas");
        mainCanvas = canvasObj.AddComponent<Canvas>();
        mainCanvas.renderMode = RenderMode.ScreenSpaceOverlay;

        var canvasScaler = canvasObj.AddComponent<CanvasScaler>();
        canvasScaler.uiScaleMode = CanvasScaler.ScaleMode.ScaleWithScreenSize;
        canvasScaler.referenceResolution = new Vector2(1920, 1080);

        var graphicsRaycaster = canvasObj.AddComponent<GraphicRaycaster>();

        // Create EventSystem if needed
        if (Object.FindAnyObjectByType<EventSystem>() == null) {
            var eventSystemObj = new GameObject("EventSystem");
            eventSystemObj.AddComponent<EventSystem>();
            eventSystemObj.AddComponent<InputSystemUIInputModule>();
        }
    }

    private void InitializePanels() {
        // Create and register all UI panels
        CreatePanel<SetupPhaseUIPanel>("SetupPhaseUIPanel");
        CreatePanel<GameStatePanel>("GameStatePanel");
        CreatePanel<GuildStatusPanel>("GuildStatusPanel");
        CreatePanel<ActionSubmissionPanel>("ActionSubmissionPanel");
        CreatePanel<ExecutionDisplayPanel>("ExecutionDisplayPanel");
        CreatePanel<FactionStandingPanel>("FactionStandingPanel");
        CreatePanel<ResourcePanel>("ResourcePanel");
        CreatePanel<VetoVotingPanel>("VetoVotingPanel");
        CreatePanel<ErrorPopupPanel>("ErrorPopupPanel");

        Debug.Log($"[UIManager] UI Manager initialized with {panels.Count} panels");
        foreach (var kvp in panels) {
            Debug.Log($"  - {kvp.Key}: {(kvp.Value.gameObject.activeSelf ? "ACTIVE" : "inactive")}");
        }
    }

    private UIPanel CreatePanel<T>(string panelName) where T : UIPanel {
        var panelObj = new GameObject(panelName);
        panelObj.transform.SetParent(mainCanvas.transform, false);

        var rectTransform = panelObj.AddComponent<RectTransform>();
        rectTransform.anchorMin = Vector2.zero;
        rectTransform.anchorMax = Vector2.one;
        rectTransform.offsetMin = Vector2.zero;
        rectTransform.offsetMax = Vector2.zero;

        var panel = panelObj.AddComponent<T>();
        panels[panelName] = panel;

        panel.Initialize();
        panel.gameObject.SetActive(false); // Start hidden

        return panel;
    }

    private void SubscribeToGameEvents() {
        Debug.Log("[UIManager] Subscribing to game events");
        EventSystem.Instance?.Subscribe<GamePhase>(GameEvents.PHASE_CHANGED, OnPhaseChanged);
        EventSystem.Instance?.Subscribe(GameEvents.SETUP_PHASE_START, OnSetupPhaseStart);
        EventSystem.Instance?.Subscribe(GameEvents.SETUP_PHASE_END, OnSetupPhaseEnd);
        EventSystem.Instance?.Subscribe<object>(GameEvents.ACTION_EXECUTED, OnActionExecuted);
        EventSystem.Instance?.Subscribe<object>(GameEvents.ACTION_FAILED, OnActionFailed);
        EventSystem.Instance?.Subscribe(GameEvents.PLANNING_PHASE_START, OnPlanningPhaseStart);
        EventSystem.Instance?.Subscribe(GameEvents.PLANNING_PHASE_END, OnPlanningPhaseEnd);
        EventSystem.Instance?.Subscribe(GameEvents.EXECUTION_PHASE_START, OnExecutionPhaseStart);
        EventSystem.Instance?.Subscribe(GameEvents.EXECUTION_PHASE_END, OnExecutionPhaseEnd);
        Debug.Log("[UIManager] Event subscriptions complete");
    }

    // ==================== PANEL MANAGEMENT ====================

    public void ShowPanel<T>(bool show = true) where T : UIPanel {
        foreach (var panel in panels.Values) {
            if (panel is T) {
                panel.gameObject.SetActive(show);
            }
        }
    }

    public void ShowError(string message, float dismissDelay = 5f) {
        var errorPanel = GetPanel<ErrorPopupPanel>();
        if (errorPanel != null) {
            errorPanel.ShowError(message, dismissDelay);
        } else {
            Debug.LogError($"[UIManager] ErrorPopupPanel not found! Error message: {message}");
        }
    }

    public void ShowAllPanels() {
        foreach (var panel in panels.Values) {
            panel.gameObject.SetActive(true);
        }
    }

    public void HideAllPanels() {
        foreach (var panel in panels.Values) {
            panel.gameObject.SetActive(false);
        }
    }

    public T GetPanel<T>(string panelName = null) where T : UIPanel {
        if (panelName != null && panels.TryGetValue(panelName, out var panel)) {
            return panel as T;
        }

        foreach (var p in panels.Values) {
            if (p is T typedPanel)
                return typedPanel;
        }
        return null;
    }

    // ==================== GAME EVENT HANDLERS ====================

    private void OnPhaseChanged(GamePhase phase) {
        Debug.Log($"[UIManager] PHASE_CHANGED fired: {phase}");

        // Update panel visibility based on phase
        switch (phase) {
            case GamePhase.Planning:
                Debug.Log("[UIManager] Detected Planning phase");
                OnPlanningPhaseStart();
                break;
            case GamePhase.Execution:
                Debug.Log("[UIManager] Detected Execution phase");
                OnExecutionPhaseStart();
                break;
            case GamePhase.Bills:
            case GamePhase.Upkeep:
                Debug.Log($"[UIManager] Detected {phase} phase");
                ShowAllPanels();
                ShowPanel<ActionSubmissionPanel>(false);
                ShowPanel<ExecutionDisplayPanel>(false);
                ShowPanel<VetoVotingPanel>(false);
                break;
        }
    }

    // ==================== Setup Phase EVENT HANDLERS ====================

    private void OnSetupPhaseStart() {
        Debug.Log("[UIManager] Setup Phase started");
        HideAllPanels();
        ShowPanel<SetupPhaseUIPanel>(true);
        ShowPanel<GameStatePanel>(true); // GameStatePanel always visible
    }

    private void OnSetupPhaseEnd() {
        Debug.Log("[UIManager] Setup Phase ended");
        ShowPanel<SetupPhaseUIPanel>(false);
        ShowPanel<GameStatePanel>(true); // Keep GameStatePanel visible
    }

    // ==================== ACTION EVENT HANDLERS ====================

    private void OnActionExecuted(object data) {
        var result = data as ActionResult;
        if (result != null) {
            var executionPanel = GetPanel<ExecutionDisplayPanel>();
            executionPanel?.DisplayActionResult(result);
        }
    }

    private void OnActionFailed(object data) {
        var result = data as ActionResult;
        if (result != null) {
            var executionPanel = GetPanel<ExecutionDisplayPanel>();
            executionPanel?.DisplayActionResult(result);
        }
    }

    private void OnPlanningPhaseStart() {
        Debug.Log("[UIManager] OnPlanningPhaseStart called");
        ShowAllPanels();
        ShowPanel<ExecutionDisplayPanel>(false);
        ShowPanel<VetoVotingPanel>(false);
        var actionPanel = GetPanel<ActionSubmissionPanel>();
        if (actionPanel != null) {
            Debug.Log("[UIManager] Found ActionSubmissionPanel, showing it");
            actionPanel.ShowPanel();
        } else {
            Debug.LogError("[UIManager] ActionSubmissionPanel not found!");
        }
    }

    private void OnPlanningPhaseEnd() {
        var actionPanel = GetPanel<ActionSubmissionPanel>();
        actionPanel?.HidePanel();
    }

    private void OnExecutionPhaseStart() {
        ShowAllPanels();
        ShowPanel<ActionSubmissionPanel>(false);
        ShowPanel<VetoVotingPanel>(false);
        var executionPanel = GetPanel<ExecutionDisplayPanel>();
        executionPanel?.ClearLog();
        executionPanel?.ShowPanel();
    }

    private void OnExecutionPhaseEnd() {
        var executionPanel = GetPanel<ExecutionDisplayPanel>();
        executionPanel?.HidePanel();
    }

    private void OnDestroy() {
        if (EventSystem.Instance != null) {
            EventSystem.Instance.Unsubscribe<GamePhase>(GameEvents.PHASE_CHANGED, OnPhaseChanged);
        }
    }
}

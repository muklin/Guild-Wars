using UnityEngine;
using UnityEngine.UI;

/// <summary>
/// GameStatePanel: Always visible.
/// Shows: Current phase, phase timer, round number, victory threshold.
/// </summary>
public class GameStatePanel : UIPanel {
    private Text phaseText;
    private Text timerText;
    private Text roundText;
    private Image timerBar;
    private GameObject setupProgressRow;
    private Text[] progressLabels = new Text[3];
    private SetupPhaseStep lastKnownStep = SetupPhaseStep.Terrain;
    private GamePhaseManager gamePhaseManager;
    private GameStateManager gameStateManager;
    private float phaseStartTime;

    public override void Initialize() {
        base.Initialize();
        gamePhaseManager = GamePhaseManager.Instance;
        gameStateManager = GameStateManager.Instance;

        if (gameStateManager == null)
            Debug.LogError("[GameStatePanel] GameStateManager not found!");

        // Position panel at top of screen
        rectTransform.anchorMin = new Vector2(0, 1);
        rectTransform.anchorMax = new Vector2(1, 1);
        rectTransform.offsetMin = new Vector2(0, -120);
        rectTransform.offsetMax = Vector2.zero;

        // Background
        var bgImg = GetComponent<Image>();
        bgImg.color = new Color(0.1f, 0.1f, 0.1f, 0.9f);
        bgImg.raycastTarget = true; // Block raycasts to world

        // Layout
        var layout = GetComponent<VerticalLayoutGroup>();
        if (layout != null) {
            layout.padding = new RectOffset(15, 15, 10, 10);
            layout.spacing = 8;
        }

        // Phase text
        var phaseObj = CreateTextObject("PhaseText", "", transform, 28);
        phaseText = phaseObj.GetComponent<Text>();
        phaseText.alignment = TextAnchor.MiddleLeft;
        phaseText.color = Color.white;

        // Setup phase progress tracker row
        var progressGO = new GameObject("SetupProgress");
        progressGO.transform.SetParent(transform, false);
        var progressLayout = progressGO.AddComponent<HorizontalLayoutGroup>();
        progressLayout.spacing = 8f;
        progressLayout.childForceExpandWidth = false;
        progressLayout.childForceExpandHeight = false;
        var progressLE = progressGO.AddComponent<LayoutElement>();
        progressLE.preferredHeight = 28;
        setupProgressRow = progressGO;

        // Create three progress labels: Terrain, Districts, Streets
        string[] stepNames = { "Terrain", "Districts", "Streets" };
        for (int i = 0; i < 3; i++) {
            var lblGO = new GameObject(stepNames[i]);
            lblGO.transform.SetParent(progressGO.transform, false);
            var lbl = lblGO.AddComponent<Text>();
            lbl.font = Resources.GetBuiltinResource<Font>("LegacyRuntime.ttf");
            lbl.text = stepNames[i];
            lbl.fontSize = 14;
            lbl.color = Color.gray;
            lbl.alignment = TextAnchor.MiddleCenter;
            var le = lblGO.AddComponent<LayoutElement>();
            le.preferredWidth = 90;
            le.preferredHeight = 24;
            progressLabels[i] = lbl;
        }

        // Subscribe to step change events
        if (EventSystem.Instance != null) {
            EventSystem.Instance.Subscribe<SetupPhaseStep>(GameEvents.SETUP_PHASE_STEP_CHANGED, OnSetupPhaseStepChanged);
        }

        // Timer and round info
        var timerObj = CreateTextObject("TimerText", "", transform, 24);
        timerText = timerObj.GetComponent<Text>();
        timerText.color = Color.yellow;

        // Timer bar
        var barObj = new GameObject("TimerBar");
        barObj.transform.SetParent(transform, false);
        timerBar = barObj.AddComponent<Image>();
        timerBar.color = Color.green;
        var barRect = barObj.GetComponent<RectTransform>();
        barRect.sizeDelta = new Vector2(400, 20);

        RefreshLayout();
    }

    private void Update() {
        if (!isVisible || gameStateManager == null)
            return;

        var currentPhase = gameStateManager.GetCurrentPhase();
        var currentRound = gameStateManager.GetCurrentRound();

        // Update phase text
        if (phaseText != null) {
            string phaseDisplay = FormatPhaseName(currentPhase);
            if (currentPhase == GamePhase.SetupPhase) {
                phaseText.text = $"Phase: {phaseDisplay}";
            } else if (gamePhaseManager != null) {
                phaseText.text = $"Round: {currentRound} | Phase: {phaseDisplay}";
            }
        }

        // Update timer (only during game loop phases)
        if (timerText != null && currentPhase != GamePhase.SetupPhase) {
            var timeRemaining = gamePhaseManager?.GetPlanningPhaseTimeRemaining() ?? 0;
            timerText.text = $"Time: {timeRemaining:F1}s | Victory Standing: 90";

            // Update timer bar
            if (timerBar != null && currentPhase == GamePhase.Planning) {
                float timeMax = 30f; // Default planning phase duration
                float fillAmount = Mathf.Clamp01(timeRemaining / timeMax);
                timerBar.fillAmount = fillAmount;
            }
        }
    }

    private string FormatPhaseName(GamePhase phase) {
        return phase switch {
            GamePhase.SetupPhase => "Setup Phase",
            GamePhase.Upkeep => "Upkeep",
            GamePhase.Planning => "Planning",
            GamePhase.Execution => "Execution",
            GamePhase.Bills => "Bills",
            _ => phase.ToString()
        };
    }

    private void OnSetupPhaseStepChanged(SetupPhaseStep step) {
        lastKnownStep = step;
        RefreshProgressTracker(step);
    }

    private void RefreshProgressTracker(SetupPhaseStep step) {
        if (setupProgressRow == null || progressLabels.Length < 3)
            return;

        bool[] complete = {
            step > SetupPhaseStep.Terrain,
            step > SetupPhaseStep.CitySubdivision,
            false
        };
        bool[] current = {
            step == SetupPhaseStep.Terrain,
            step == SetupPhaseStep.CitySubdivision,
            false
        };
        string[] names = { "Terrain", "Districts", "Streets" };
        Color completedColor = new Color(0.3f, 0.9f, 0.3f);
        Color currentColor = Color.white;
        Color futureColor = Color.gray;

        for (int i = 0; i < 3; i++) {
            if (progressLabels[i] == null)
                continue;

            if (complete[i]) {
                progressLabels[i].text = $"[{names[i]} ✓]";
                progressLabels[i].color = completedColor;
            } else if (current[i]) {
                progressLabels[i].text = $"[{names[i]} →]";
                progressLabels[i].color = currentColor;
            } else {
                progressLabels[i].text = $"[{names[i]}]";
                progressLabels[i].color = futureColor;
            }
        }

        // Hide progress row when not in setup phase
        if (setupProgressRow != null) {
            var canvasGroup = setupProgressRow.GetComponent<CanvasGroup>();
            if (canvasGroup == null)
                canvasGroup = setupProgressRow.AddComponent<CanvasGroup>();

            var currentPhase = gameStateManager?.GetCurrentPhase() ?? GamePhase.SetupPhase;
            canvasGroup.alpha = (currentPhase == GamePhase.SetupPhase) ? 1f : 0f;
            canvasGroup.blocksRaycasts = (currentPhase == GamePhase.SetupPhase);
        }
    }
}

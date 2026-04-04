using UnityEngine;

/// <summary>
/// GameStatePanel: Always visible.
/// Shows: Current phase, phase timer, round number, victory threshold.
/// </summary>
public class GameStatePanel : UIPanel
{
    private Text phaseText;
    private Text timerText;
    private Text roundText;
    private Image timerBar;
    private GamePhaseManager gamePhaseManager;
    private GameStateManager gameStateManager;
    private float phaseStartTime;

    public override void Initialize()
    {
        base.Initialize();
        gamePhaseManager = GamePhaseManager.Instance;
        gameStateManager = GameStateManager.Instance;

        // Position panel at top of screen
        rectTransform.anchorMin = new Vector2(0, 1);
        rectTransform.anchorMax = new Vector2(1, 1);
        rectTransform.offsetMin = new Vector2(0, -120);
        rectTransform.offsetMax = Vector2.zero;

        // Background
        var bgImg = GetComponent<Image>();
        bgImg.color = new Color(0.1f, 0.1f, 0.1f, 0.9f);

        // Layout
        var layout = GetComponent<VerticalLayoutGroup>();
        if (layout != null)
        {
            layout.padding = new RectOffset(15, 15, 10, 10);
            layout.spacing = 8;
        }

        // Phase text
        var phaseObj = CreateTextObject("PhaseText", "Round: 1 | Phase: Upkeep", transform, 28);
        phaseText = phaseObj.GetComponent<Text>();
        phaseText.alignment = TextAnchor.MiddleLeft;
        phaseText.color = Color.white;

        // Timer and round info
        var timerObj = CreateTextObject("TimerText", "Time: 30s | Victory Standing: 90", transform, 24);
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

    private void Update()
    {
        if (!isVisible || gamePhaseManager == null) return;

        var currentPhase = gameStateManager.GetCurrentPhase();
        var currentRound = gameStateManager.GetCurrentRound();
        var timeRemaining = gamePhaseManager.GetPlanningPhaseTimeRemaining();

        // Update phase text
        if (phaseText != null)
        {
            phaseText.text = $"Round: {currentRound} | Phase: {currentPhase}";
        }

        // Update timer
        if (timerText != null)
        {
            timerText.text = $"Time: {timeRemaining:F1}s | Victory Standing: 90";
        }

        // Update timer bar
        if (timerBar != null && currentPhase == GamePhase.Planning)
        {
            float timeMax = 30f; // Default planning phase duration
            float fillAmount = Mathf.Clamp01(timeRemaining / timeMax);
            timerBar.fillAmount = fillAmount;
        }
    }
}

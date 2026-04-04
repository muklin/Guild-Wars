using UnityEngine;
using UnityEngine.UI;

/// <summary>
/// ResourcePanel: Shows resource production/consumption breakdown.
/// Displays district balance sheet and guild income sources.
/// </summary>
public class ResourcePanel : UIPanel
{
    private GameStateManager gameStateManager;

    public override void Initialize()
    {
        base.Initialize();
        gameStateManager = GameStateManager.Instance;

        // Position: bottom-right
        rectTransform.anchorMin = new Vector2(0.66f, 0);
        rectTransform.anchorMax = Vector2.one;
        rectTransform.offsetMin = Vector2.zero;
        rectTransform.offsetMax = new Vector2(0, -120);

        // Background
        GetComponent<Image>().color = new Color(0.2f, 0.15f, 0.1f, 0.9f);

        CreateTextObject("Title", "Resources", transform, 20).GetComponent<Text>().color = Color.yellow;
        CreateTextObject("Info", "Resource system information", transform, 14).GetComponent<Text>().color = Color.gray;

        RefreshLayout();
    }
}

/// <summary>
/// VetoVotingPanel: Shown when a veto is called.
/// Displays statement, vote options, and results.
/// </summary>
public class VetoVotingPanel : UIPanel
{
    private Text statementText;
    private Button yesButton;
    private Button noButton;
    private Text resultText;
    private Image resultBackground;

    public override void Initialize()
    {
        base.Initialize();

        // Position: center screen
        rectTransform.anchorMin = new Vector2(0.2f, 0.35f);
        rectTransform.anchorMax = new Vector2(0.8f, 0.75f);
        rectTransform.offsetMin = Vector2.zero;
        rectTransform.offsetMax = Vector2.zero;

        // Background
        var bgImg = GetComponent<Image>();
        bgImg.color = new Color(0.3f, 0.1f, 0.1f, 0.95f);
        resultBackground = bgImg;

        // Title
        CreateTextObject("Title", "VETO CALLED", transform, 28).GetComponent<Text>().color = Color.red;

        // Statement
        statementText = CreateTextObject("Statement", "Statement being vetoed...", transform, 20).GetComponent<Text>();
        statementText.color = Color.white;
        statementText.alignment = TextAnchor.MiddleCenter;

        // Voting buttons
        yesButton = CreateButtonWithText("YesButton", "Accept", transform, () => Debug.Log("Veto accepted"))
            .GetComponent<Button>();

        noButton = CreateButtonWithText("NoButton", "Reject", transform, () => Debug.Log("Veto rejected"))
            .GetComponent<Button>();

        // Result
        resultText = CreateTextObject("Result", "Waiting for votes...", transform, 24).GetComponent<Text>();
        resultText.color = Color.yellow;
        resultText.alignment = TextAnchor.MiddleCenter;

        RefreshLayout();
    }

    public void SetStatement(string statement)
    {
        if (statementText != null)
        {
            statementText.text = statement;
        }
    }

    public void SetResult(bool passed)
    {
        if (resultText != null)
        {
            resultText.text = passed ? "VETO PASSED" : "VETO FAILED";
            resultText.color = passed ? Color.green : Color.red;
        }

        yesButton.interactable = false;
        noButton.interactable = false;
    }
}

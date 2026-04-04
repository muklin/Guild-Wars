using UnityEngine;
using System.Collections.Generic;

/// <summary>
/// ExecutionDisplayPanel: Shown during Execution phase.
/// Displays action log with results and moderate visual feedback.
/// Shows: combat rolls, outcomes, faction changes, district control changes.
/// </summary>
public class ExecutionDisplayPanel : UIPanel
{
    private ScrollRect scrollRect;
    private Text logText;
    private List<ActionResult> actionLog = new();
    private VerticalLayoutGroup verticalLayout;

    public override void Initialize()
    {
        base.Initialize();

        // Position: center
        rectTransform.anchorMin = new Vector2(0.2f, 0.25f);
        rectTransform.anchorMax = new Vector2(0.8f, 0.95f);
        rectTransform.offsetMin = Vector2.zero;
        rectTransform.offsetMax = Vector2.zero;

        // Background
        GetComponent<Image>().color = new Color(0.1f, 0.1f, 0.15f, 0.95f);

        // Remove default layout if any
        var defaultLayout = GetComponent<VerticalLayoutGroup>();
        if (defaultLayout != null)
        {
            DestroyImmediate(defaultLayout);
        }

        // Title
        CreateTextObject("Title", "Execution Log", transform, 28).GetComponent<Text>().color = Color.white;

        // Create scroll view
        var scrollObj = new GameObject("ScrollView");
        scrollObj.transform.SetParent(transform, false);
        scrollRect = scrollObj.AddComponent<ScrollRect>();

        var scrollBg = scrollObj.AddComponent<Image>();
        scrollBg.color = new Color(0.05f, 0.05f, 0.1f, 1f);

        var scrollRect_rt = scrollObj.GetComponent<RectTransform>();
        scrollRect_rt.anchorMin = Vector2.zero;
        scrollRect_rt.anchorMax = Vector2.one;
        scrollRect_rt.offsetMin = new Vector2(10, 50);
        scrollRect_rt.offsetMax = new Vector2(-10, -10);

        // Scrollbar
        var scrollbarObj = new GameObject("Scrollbar");
        scrollbarObj.transform.SetParent(scrollObj.transform, false);
        var scrollbar = scrollbarObj.AddComponent<Scrollbar>();
        scrollbar.direction = Scrollbar.Direction.BottomToTop;
        var scrollbarBg = scrollbarObj.AddComponent<Image>();
        scrollbarBg.color = new Color(0.1f, 0.1f, 0.1f, 1f);
        var scrollbarRect = scrollbarObj.GetComponent<RectTransform>();
        scrollbarRect.anchorMin = new Vector2(1, 0);
        scrollbarRect.anchorMax = Vector2.one;
        scrollbarRect.offsetMin = new Vector2(-15, 0);
        scrollbarRect.offsetMax = Vector2.zero;
        scrollRect.verticalScrollbar = scrollbar;

        // Content
        var contentObj = new GameObject("Content");
        contentObj.transform.SetParent(scrollObj.transform, false);
        var contentLayout = contentObj.AddComponent<VerticalLayoutGroup>();
        contentLayout.padding = new RectOffset(10, 10, 10, 10);
        contentLayout.spacing = 5;
        contentLayout.childForceExpandHeight = false;
        contentLayout.childForceExpandWidth = true;

        var contentFitter = contentObj.AddComponent<ContentSizeFitter>();
        contentFitter.verticalFit = ContentSizeFitter.FitMode.PreferredSize;

        var contentRect = contentObj.GetComponent<RectTransform>();
        contentRect.anchorMin = new Vector2(0, 1);
        contentRect.anchorMax = Vector2.one;
        contentRect.offsetMin = Vector2.zero;
        contentRect.offsetMax = Vector2.zero;

        scrollRect.content = contentRect;

        // Log text (single text element in content)
        logText = CreateTextObject("LogText", "", contentObj.transform, 16).GetComponent<Text>();
        logText.color = Color.white;
        logText.alignment = TextAnchor.UpperLeft;
        var logTextRect = logText.GetComponent<RectTransform>();
        logTextRect.anchorMin = new Vector2(0, 1);
        logTextRect.anchorMax = Vector2.one;
        logTextRect.offsetMin = Vector2.zero;
        logTextRect.offsetMax = Vector2.zero;

        RefreshLayout();
    }

    public void DisplayActionResult(ActionResult result)
    {
        if (result == null) return;

        actionLog.Add(result);
        UpdateLogDisplay();
    }

    public void ClearLog()
    {
        actionLog.Clear();
        UpdateLogDisplay();
    }

    private void UpdateLogDisplay()
    {
        string logContent = "";

        foreach (var result in actionLog)
        {
            if (result.Success)
            {
                logContent += $"<color=green>✓ SUCCESS:</color> {result.Message}\n";
            }
            else
            {
                logContent += $"<color=red>✗ FAILED:</color> {result.Message}\n";
            }

            if (result.GoldChange != 0)
            {
                logContent += $"  <color=yellow>Gold: {(result.GoldChange > 0 ? "+" : "")}{result.GoldChange}gp</color>\n";
            }

            if (result.FactionStandingChange != 0)
            {
                logContent += $"  <color=cyan>Faction Standing: {(result.FactionStandingChange > 0 ? "+" : "")}{result.FactionStandingChange}</color>\n";
            }

            logContent += "\n";
        }

        if (logText != null)
        {
            logText.text = logContent;
        }

        // Auto-scroll to bottom
        if (scrollRect != null)
        {
            Canvas.ForceUpdateCanvases();
            scrollRect.verticalNormalizedPosition = 0f;
        }
    }

    public override void ShowPanel()
    {
        base.ShowPanel();
        ClearLog();
    }
}

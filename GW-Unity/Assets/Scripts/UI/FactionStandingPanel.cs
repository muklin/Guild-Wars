using UnityEngine;
using UnityEngine.UI;

/// <summary>
/// FactionStandingPanel: Shows faction standings for all guilds.
/// Displays: Faction names and standing bars (0-100 scale).
/// Color-coded: Red (hostile), Yellow (neutral), Green (ally).
/// Highlights guilds winning (>= 90 standing).
/// </summary>
public class FactionStandingPanel : UIPanel
{
    private GameStateManager gameStateManager;
    private VerticalLayoutGroup verticalLayout;

    public override void Initialize()
    {
        base.Initialize();
        gameStateManager = GameStateManager.Instance;

        // Position: right side
        rectTransform.anchorMin = new Vector2(0.66f, 0);
        rectTransform.anchorMax = Vector2.one;
        rectTransform.offsetMin = new Vector2(0, -120);
        rectTransform.offsetMax = Vector2.zero;

        // Background
        GetComponent<Image>().color = new Color(0.15f, 0.2f, 0.15f, 0.9f);

        // Remove default layout, add proper one
        verticalLayout = GetComponent<VerticalLayoutGroup>();
        if (verticalLayout == null)
        {
            verticalLayout = gameObject.AddComponent<VerticalLayoutGroup>();
        }
        verticalLayout.padding = new RectOffset(130, 10, 10, 10);
        verticalLayout.spacing = 5;
        verticalLayout.childForceExpandHeight = false;
        verticalLayout.childForceExpandWidth = true;

        // Title
        CreateTextObject("Title", "Faction Standings", transform, 24).GetComponent<Text>().color = Color.white;

        RefreshLayout();
    }

    private void Update()
    {
        if (!isVisible || gameStateManager == null) return;

        RefreshDisplay();
    }

    private void RefreshDisplay()
    {
        // Clear old displays
        foreach (Transform child in transform)
        {
            if (child.name != "Title")
            {
                Destroy(child.gameObject);
            }
        }

        var factions = gameStateManager.GetAllFactions();
        var guilds = gameStateManager.GetAllGuilds();

        foreach (var faction in factions)
        {
            // Faction header
            CreateTextObject($"Faction_{faction.Id}", $"<b>{faction.Name}</b>", transform, 18).GetComponent<Text>().color = Color.cyan;

            // Standing bars for each guild
            foreach (var guild in guilds)
            {
                int standing = guild.GetFactionStanding(faction.Id);

                // Background bar
                var barBgObj = new GameObject($"Standing_{guild.Id}_bg");
                barBgObj.transform.SetParent(transform, false);
                var barBgImg = barBgObj.AddComponent<Image>();
                barBgImg.color = new Color(0.2f, 0.2f, 0.2f, 1f);
                var barBgRect = barBgObj.GetComponent<RectTransform>();
                barBgRect.sizeDelta = new Vector2(200, 20);

                // Foreground bar (filled)
                var barFgObj = new GameObject($"Standing_{guild.Id}_fg");
                barFgObj.transform.SetParent(barBgObj.transform, false);
                var barFgImg = barFgObj.AddComponent<Image>();

                // Color based on standing
                if (standing <= 20)
                    barFgImg.color = Color.red; // Hostile
                else if (standing <= 50)
                    barFgImg.color = Color.yellow; // Neutral
                else if (standing < 90)
                    barFgImg.color = Color.green; // Friendly
                else
                    barFgImg.color = new Color(0, 1, 0.5f, 1); // Ally (winning)

                var barFgRect = barFgObj.GetComponent<RectTransform>();
                barFgRect.anchorMin = Vector2.zero;
                barFgRect.anchorMax = new Vector2(standing / 100f, 1);
                barFgRect.offsetMin = Vector2.zero;
                barFgRect.offsetMax = Vector2.zero;

                // Standing text
                var textObj = CreateTextObject($"Standing_{guild.Id}_text", $"{guild.Name}: {standing}/100", transform, 14);
                var textComponent = textObj.GetComponent<Text>();
                textComponent.color = Color.white;

                // Winning indicator
                if (standing >= 90)
                {
                    textComponent.text += " ✓ WINNING";
                    textComponent.color = new Color(0, 1, 0.5f, 1);
                }
            }

            // Spacing between factions
            var spacer = new GameObject("Spacer");
            spacer.transform.SetParent(transform, false);
            var spacerRect = spacer.AddComponent<RectTransform>();
            spacerRect.sizeDelta = new Vector2(200, 10);
        }

        RefreshLayout();
    }
}

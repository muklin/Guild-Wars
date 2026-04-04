using UnityEngine;
using System.Collections.Generic;

/// <summary>
/// GuildStatusPanel: Shows player/guild information.
/// Displays: Guild name, resources, character roster, leader, veto tokens, controlled districts.
/// Implemented for moderate polish with color-coding per guild.
/// </summary>
public class GuildStatusPanel : UIPanel
{
    private Dictionary<int, GuildStatusDisplay> guildDisplays = new();
    private GameStateManager gameStateManager;
    private HorizontalLayoutGroup horizontalLayout;

    public override void Initialize()
    {
        base.Initialize();
        gameStateManager = GameStateManager.Instance;

        // Position: left side of screen
        rectTransform.anchorMin = Vector2.zero;
        rectTransform.anchorMax = new Vector2(0.33f, 1);
        rectTransform.offsetMin = new Vector2(0, -120);
        rectTransform.offsetMax = Vector2.zero;

        // Remove default vertical layout FIRST
        var verticalLayout = GetComponent<VerticalLayoutGroup>();
        if (verticalLayout != null)
        {
            DestroyImmediate(verticalLayout);
        }

        // Use horizontal layout to show multiple guilds side by side
        horizontalLayout = gameObject.AddComponent<HorizontalLayoutGroup>();
        horizontalLayout.padding = new RectOffset(10, 10, 130, 10);
        horizontalLayout.spacing = 10;
        horizontalLayout.childForceExpandHeight = true;
        horizontalLayout.childForceExpandWidth = true;

        RefreshLayout();
    }

    private void Start()
    {
        RefreshGuildDisplays();
    }

    private void RefreshGuildDisplays()
    {
        var allGuilds = gameStateManager.GetAllGuilds();

        // Clear old displays
        foreach (var transform in gameObject.GetComponentsInChildren<Transform>())
        {
            if (transform != this.transform && transform.parent == this.transform)
            {
                Destroy(transform.gameObject);
            }
        }
        guildDisplays.Clear();

        // Create display for each guild
        int guildIndex = 0;
        foreach (var guild in allGuilds)
        {
            var display = CreateGuildDisplay(guild, guildIndex);
            guildDisplays[guild.Id] = display;
            guildIndex++;
        }

        RefreshLayout();
    }

    private GuildStatusDisplay CreateGuildDisplay(Guild guild, int index)
    {
        // Guild panel with color coding
        Color[] guildColors = new Color[]
        {
            new Color(0.8f, 0.2f, 0.2f, 0.9f), // Red for player
            new Color(0.2f, 0.2f, 0.8f, 0.9f), // Blue for NPC 1
            new Color(0.2f, 0.8f, 0.2f, 0.9f)  // Green for NPC 2
        };

        var panelObj = CreatePanel($"Guild_{guild.Name}", transform, guildColors[Mathf.Min(index, 2)]);

        // Guild name
        CreateTextObject("GuildName", $"<b>{guild.Name}</b>", panelObj.transform, 24).GetComponent<Text>().color = Color.white;

        // Resources
        CreateTextObject("Resources", $"Gold: {guild.Gold}gp", panelObj.transform, 20).GetComponent<Text>().color = Color.yellow;

        // Leader
        string leaderName = guild.Members.Count > 0 ? guild.Members[0].Name : "None";
        CreateTextObject("Leader", $"Leader: {leaderName}", panelObj.transform, 18).GetComponent<Text>().color = Color.cyan;

        // Veto tokens (placeholder - would need VetoManager integration)
        CreateTextObject("VetoTokens", "Veto Tokens: 1", panelObj.transform, 18).GetComponent<Text>().color = Color.magenta;

        // Character roster header
        CreateTextObject("RosterHeader", "<b>Members:</b>", panelObj.transform, 18).GetComponent<Text>().color = Color.white;

        // Character list
        foreach (var character in guild.Members)
        {
            string status = character.IsIncapacitated ? "[INCAP]" : "[OK]";
            string charDisplay = $"{character.Name} (Lv{character.Level}) {status}";
            CreateTextObject($"Char_{character.Id}", charDisplay, panelObj.transform, 16).GetComponent<Text>().color = Color.gray;
        }

        // Controlled districts
        if (guild.ControlledDistrictIds.Count > 0)
        {
            CreateTextObject("DistrictsHeader", "<b>Districts:</b>", panelObj.transform, 18).GetComponent<Text>().color = Color.white;
            foreach (int districtId in guild.ControlledDistrictIds)
            {
                var district = gameStateManager.GetDistrict(districtId);
                if (district != null)
                {
                    CreateTextObject($"District_{districtId}", district.Name, panelObj.transform, 16).GetComponent<Text>().color = new Color(0.7f, 0.7f, 1f);
                }
            }
        }

        return new GuildStatusDisplay { PanelObject = panelObj, GuildId = guild.Id };
    }

    public override void Refresh()
    {
        RefreshGuildDisplays();
    }

    private class GuildStatusDisplay
    {
        public GameObject PanelObject;
        public int GuildId;
    }
}

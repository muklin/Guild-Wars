using System.Collections.Generic;
using System.Linq;
using UnityEngine;

/// <summary>
/// Centralized faction logic.
/// Manages faction standings, updates after actions, checks victory conditions.
///
/// Districts, Guilds, TradingDestinations, and ClassFactions are all Factions.
/// A guild's standing with a district is tracked by district.Id (district IS the faction).
/// </summary>
public class FactionManager
{
    private GameStateManager gameStateManager;

    public FactionManager(GameStateManager stateManager)
    {
        gameStateManager = stateManager;
    }

    // ==================== FACTION STANDING UPDATES ====================

    /// <summary>
    /// Award a standing bonus to a guild for controlling a district.
    /// The district IS the faction — we update standing directly by district.Id.
    /// </summary>
    public void UpdateStandingFromDistrictControl(Guild guild, District district)
    {
        const int controlBonus = 10;
        int oldStanding = guild.GetFactionStanding(district.Id);
        int newStanding = Mathf.Clamp(oldStanding + controlBonus, 0, 100);
        guild.UpdateFactionStanding(district.Id, newStanding);
        EventSystem.Instance?.Fire(GameEvents.FACTION_STANDING_CHANGED, guild, (Faction)district);
    }

    public void UpdateStandingFromMission(Guild guild, Faction faction, int amount)
    {
        int oldStanding = guild.GetFactionStanding(faction.Id);
        int newStanding = Mathf.Clamp(oldStanding + amount, 0, 100);
        guild.UpdateFactionStanding(faction.Id, newStanding);
        EventSystem.Instance?.Fire(GameEvents.FACTION_MISSION_COMPLETED, guild, faction);
    }

    // ==================== VICTORY CONDITIONS ====================

    public Guild CheckVictoryCondition()
    {
        foreach (var guild in gameStateManager.GetAllGuilds())
        {
            if (HasWon(guild)) return guild;
        }
        return null;
    }

    public bool HasWon(Guild guild)
    {
        var factionStandings = guild.GetAllFactionStandings();
        var victories = factionStandings
            .Where(kvp => kvp.Value >= GetVictoryThreshold(kvp.Key))
            .ToList();
        return victories.Count >= 2;
    }

    private int GetVictoryThreshold(int factionId)
    {
        var faction = gameStateManager.GetFaction(factionId);
        return faction != null ? faction.VictoryThreshold : 90;
    }

    // ==================== FACTION QUERIES ====================

    /// <summary>Returns the district itself as its own faction.</summary>
    public List<Faction> GetFactionsForDistrict(District district) =>
        new List<Faction> { district };

    public Dictionary<Faction, int> GetGuildFactionStandings(Guild guild)
    {
        var standings = new Dictionary<Faction, int>();
        foreach (var faction in gameStateManager.GetAllFactions())
        {
            standings[faction] = guild.GetFactionStanding(faction.Id);
        }
        return standings;
    }

    public void PrintFactionStandings(Guild guild)
    {
        Debug.Log($"=== Faction Standings for {guild.Name} ===");
        foreach (var kvp in GetGuildFactionStandings(guild))
        {
            Debug.Log($"{kvp.Key.Name}: {kvp.Value}/100");
        }
    }
}

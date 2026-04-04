using System.Collections.Generic;
using System.Linq;
using UnityEngine;

/// <summary>
/// Centralized faction logic.
/// Manages faction standings, updates after actions, checks victory conditions.
/// </summary>
public class FactionManager
{
    private GameStateManager gameStateManager;
    private List<Faction> factions;

    public FactionManager(GameStateManager stateManager)
    {
        gameStateManager = stateManager;
        factions = gameStateManager.GetAllFactions();
    }

    // ==================== FACTION STANDING UPDATES ====================

    public void UpdateStandingFromDistrictControl(Guild guild, District district)
    {
        if (district.AssociatedFaction == null) return;

        // Bonus for controlling faction origin district
        int bonus = district.AssociatedFaction.CalculateOriginDistrictBonus(
            district.Id == district.AssociatedFaction.OriginDistrictId
        );

        int oldStanding = guild.GetFactionStanding(district.AssociatedFaction.Id);
        int newStanding = Mathf.Clamp(oldStanding + bonus, 0, 100);
        guild.UpdateFactionStanding(district.AssociatedFaction.Id, newStanding);

        EventSystem.Instance?.Fire(GameEvents.FACTION_STANDING_CHANGED, guild, district.AssociatedFaction);
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
            if (HasWon(guild))
                return guild;
        }
        return null;
    }

    public bool HasWon(Guild guild)
    {
        // Guild must have reached victory threshold with at least 2 factions
        var factionStandings = guild.GetAllFactionStandings();
        var victoriesFactions = factionStandings
            .Where(kvp => kvp.Value >= GetVictoryThreshold(kvp.Key))
            .ToList();

        return victoriesFactions.Count >= 2;
    }

    private int GetVictoryThreshold(int factionId)
    {
        var faction = gameStateManager.GetFaction(factionId);
        return faction != null ? faction.VictoryThreshold : 90;
    }

    // ==================== FACTION QUERIES ====================

    public List<Faction> GetFactionsForDistrict(District district)
    {
        if (district.AssociatedFaction == null)
            return new List<Faction>();

        return new List<Faction> { district.AssociatedFaction };
    }

    public Dictionary<Faction, int> GetGuildFactionStandings(Guild guild)
    {
        var standings = new Dictionary<Faction, int>();
        foreach (var faction in factions)
        {
            standings[faction] = guild.GetFactionStanding(faction.Id);
        }
        return standings;
    }

    public void PrintFactionStandings(Guild guild)
    {
        Debug.Log($"=== Faction Standings for {guild.Name} ===");
        var standings = GetGuildFactionStandings(guild);
        foreach (var kvp in standings)
        {
            Debug.Log($"{kvp.Key.Name}: {kvp.Value}/100");
        }
    }
}

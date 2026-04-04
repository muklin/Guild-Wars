using System.Collections.Generic;

/// <summary>
/// Represents a faction that guilds can gain influence with.
/// </summary>
public class Faction
{
    public int Id { get; private set; }
    public string Name { get; set; }
    public string Description { get; set; }

    // Origin district (where faction is based)
    public int OriginDistrictId { get; set; }

    // Resources and services this faction produces/needs
    public List<string> ProducedResources { get; private set; } = new();
    public List<string> NeededResources { get; private set; } = new();

    // Victory condition - standing required to help guild win
    public int VictoryThreshold { get; set; } = 90;

    // Bonuses for having standing in this faction
    public int FactionBonusStandingBonus { get; set; } = 10; // How much standing bonus for HQ in origin district
    public int MaxStandingBonus { get; set; } = 20;

    private static int nextId = 1;

    public Faction(string name)
    {
        Id = nextId++;
        Name = name;
    }

    // ==================== RESOURCES ====================

    public void AddProducedResource(string resource)
    {
        if (!ProducedResources.Contains(resource))
            ProducedResources.Add(resource);
    }

    public void AddNeededResource(string resource)
    {
        if (!NeededResources.Contains(resource))
            NeededResources.Add(resource);
    }

    public bool ProducesResource(string resource)
    {
        return ProducedResources.Contains(resource);
    }

    public bool NeedsResource(string resource)
    {
        return NeededResources.Contains(resource);
    }

    // ==================== STANDING ====================

    /// <summary>
    /// Calculates the standing bonus for a guild based on controlling the origin district.
    /// </summary>
    public int CalculateOriginDistrictBonus(bool controlsOrigin)
    {
        return controlsOrigin ? FactionBonusStandingBonus : 0;
    }

    public override string ToString()
    {
        return $"Faction[{Name}, VictoryThreshold={VictoryThreshold}]";
    }
}

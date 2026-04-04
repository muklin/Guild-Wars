using System.Collections.Generic;
using UnityEngine;

/// <summary>
/// District classification that affects faction standing bonuses
/// </summary>
public enum DistrictClass
{
    Neutral,
    Commerce,
    Military,
    Magical,
    Religious,
    Noble
}

/// <summary>
/// Represents a district in the city.
/// Each district has resources, can be controlled by guilds, and has faction associations.
/// </summary>
public class District
{
    public int Id { get; private set; }
    public string Name { get; set; }
    public string Description { get; set; }

    // Location in the city (for 3D view)
    public Vector3 WorldPosition { get; set; }

    // Control
    public int ControllingGuildId { get; set; } = -1; // -1 means no control
    public Faction AssociatedFaction { get; set; }

    // Resources produced and consumed
    public Dictionary<string, int> ProducedResources { get; private set; } = new();
    public Dictionary<string, int> ConsumedResources { get; private set; } = new();

    // District class (affects faction standing bonuses)
    public DistrictClass Class { get; set; } = DistrictClass.Neutral;

    // Adjacency for district control
    public List<int> AdjacentDistrictIds { get; private set; } = new();

    // For gameplay
    public bool IsWalled { get; set; }
    public Threat ThreatSource { get; set; }
    public bool IsThreatened => ThreatSource != null && !ThreatSource.IsMitigated;

    private static int nextId = 1;

    public District(string name, Vector3 worldPosition)
    {
        Id = nextId++;
        Name = name;
        WorldPosition = worldPosition;
    }

    // ==================== RESOURCES ====================

    public void AddProducedResource(string resourceType, int amount)
    {
        if (!ProducedResources.ContainsKey(resourceType))
            ProducedResources[resourceType] = 0;
        ProducedResources[resourceType] += amount;
    }

    public void AddConsumedResource(string resourceType, int amount)
    {
        if (!ConsumedResources.ContainsKey(resourceType))
            ConsumedResources[resourceType] = 0;
        ConsumedResources[resourceType] += amount;
    }

    public Dictionary<string, int> GenerateResources()
    {
        return new Dictionary<string, int>(ProducedResources);
    }

    public Dictionary<string, int> GetRequiredResources()
    {
        return new Dictionary<string, int>(ConsumedResources);
    }

    // ==================== ADJACENCY ====================

    public void AddAdjacentDistrict(int districtId)
    {
        if (!AdjacentDistrictIds.Contains(districtId))
            AdjacentDistrictIds.Add(districtId);
    }

    public bool IsAdjacent(int districtId)
    {
        return AdjacentDistrictIds.Contains(districtId);
    }

    // ==================== CONTROL ====================

    public bool IsControlled()
    {
        return ControllingGuildId != -1;
    }

    public bool IsControlledBy(int guildId)
    {
        return ControllingGuildId == guildId;
    }

    public override string ToString()
    {
        string controller = ControllingGuildId == -1 ? "Uncontrolled" : $"Guild {ControllingGuildId}";
        return $"District[{Name}, Controller={controller}, Threatened={IsThreatened}]";
    }
}

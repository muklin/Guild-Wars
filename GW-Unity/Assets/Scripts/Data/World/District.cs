using System.Collections.Generic;
using UnityEngine;

/// <summary>
/// District classification that affects the type of faction standing bonuses available.
/// </summary>
public enum DistrictClass {
    Neutral,
    Commerce,
    Military,
    Magical,
    Religious,
    Noble,
    Slums,
    Entertainment,
    Industrial,
    Agricultural
}

/// <summary>
/// A district in the city. Each District is automatically also a Faction — each district represents the societal
/// group or power bloc that inhabits it. Guilds gain or lose standing with a District Faction by
/// controlling it, trading with it, or acting within it.
///
/// holds ProducedResources / ConsumedResources dictionaries for upkeep amount tracking.
/// </summary>
public class District : Faction {
    // Location in the 3D city
    public Vector3 WorldPosition { get; set; }

    // Which guild currently controls this district (-1 = uncontrolled)
    public int ControllingGuildId { get; set; } = -1;

    // Optional label for the dominant group in this district (e.g. "Merchants Guild")
    public string FactionLabel { get; set; }

    // Resource amounts for upkeep calculations (keyed by resource name)
    public Dictionary<string, int> ProducedResources { get; private set; } = new();
    public Dictionary<string, int> ConsumedResources { get; private set; } = new();

    // District classification
    public DistrictClass Class { get; set; } = DistrictClass.Neutral;

    // Adjacency graph (district IDs)
    public List<int> AdjacentDistrictIds { get; private set; } = new();

    // Gameplay state
    public Threat ThreatSource { get; set; }
    public bool IsThreatened => ThreatSource != null && !ThreatSource.IsMitigated;

    public District(string name, Vector3 worldPosition) : base(name) {
        WorldPosition = worldPosition;
    }

    // ==================== RESOURCES ====================

    /// <summary>
    /// Add an amount of a produced resource. Also registers it in the typed Faction.Produces list.
    /// </summary>
    public void AddProducedResource(string resourceType, int amount) {
        if (!ProducedResources.ContainsKey(resourceType))
            ProducedResources[resourceType] = 0;
        ProducedResources[resourceType] += amount;
        // Sync to the typed Faction list (creates a Resource if not already present)
        AddProducedResource(resourceType);
    }

    /// <summary>
    /// Add an amount of a consumed resource. Also registers it in the typed Faction.Needs list.
    /// </summary>
    public void AddConsumedResource(string resourceType, int amount) {
        if (!ConsumedResources.ContainsKey(resourceType))
            ConsumedResources[resourceType] = 0;
        ConsumedResources[resourceType] += amount;
        AddNeededResource(resourceType);
    }

    public Dictionary<string, int> GenerateResources() => new(ProducedResources);
    public Dictionary<string, int> GetRequiredResources() => new(ConsumedResources);

    // ==================== ADJACENCY ====================

    public void AddAdjacentDistrict(int districtId) {
        if (!AdjacentDistrictIds.Contains(districtId))
            AdjacentDistrictIds.Add(districtId);
    }

    public bool IsAdjacent(int districtId) => AdjacentDistrictIds.Contains(districtId);

    // ==================== CONTROL ====================

    public bool IsControlled() => ControllingGuildId != -1;
    public bool IsControlledBy(int guildId) => ControllingGuildId == guildId;

    public override string ToString() {
        string controller = ControllingGuildId == -1 ? "Uncontrolled" : $"Guild {ControllingGuildId}";
        return $"District[{Name}, Controller={controller}, Threatened={IsThreatened}]";
    }
}

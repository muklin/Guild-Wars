using System.Collections.Generic;
using UnityEngine;

/// <summary>
/// Represents a single building/structure within a city block.
/// Part of the hierarchical terrain system: World (TerrainData) → City (DistrictData) → Block (BuildingData).
/// </summary>
public class Building
{
    public int Id { get; set; }
    public string Name { get; set; }
    public Vector3 Position { get; set; }
    public int DistrictId { get; set; }                  // Parent district
    public int ControllingGuildId { get; set; } = -1;   // -1 = uncontrolled/neutral
    public string BuildingType { get; set; }             // "House", "Shop", "Guard Post", etc.
    public int Level { get; set; } = 1;                  // Upgrade/development level

    public Building()
    {
    }

    public Building(int id, string name, Vector3 position, int districtId)
    {
        Id = id;
        Name = name;
        Position = position;
        DistrictId = districtId;
    }

    public override string ToString() =>
        $"Building[{Id}, {Name}, Type={BuildingType}, Controller={ControllingGuildId}]";
}

/// <summary>
/// Centralized storage for block-scale building architecture.
/// Manages individual buildings within districts: ownership, type, resources, defenses.
/// </summary>
public class BuildingData
{
    private List<Building> buildings = new();
    public IReadOnlyList<Building> Buildings => buildings.AsReadOnly();

    public int BuildingCount => buildings.Count;

    /// <summary>Get a building by ID.</summary>
    public Building GetBuilding(int id)
    {
        return buildings.Find(b => b.Id == id);
    }

    /// <summary>Get all buildings.</summary>
    public List<Building> GetAllBuildings() => new(buildings);

    /// <summary>Get all buildings in a specific district.</summary>
    public List<Building> GetBuildingsInDistrict(int districtId)
    {
        return buildings.FindAll(b => b.DistrictId == districtId);
    }

    /// <summary>Get all buildings controlled by a specific guild.</summary>
    public List<Building> GetBuildingsControlledBy(int guildId)
    {
        return buildings.FindAll(b => b.ControllingGuildId == guildId);
    }

    /// <summary>Get all buildings of a specific type.</summary>
    public List<Building> GetBuildingsByType(string buildingType)
    {
        return buildings.FindAll(b => b.BuildingType == buildingType);
    }

    /// <summary>Get all uncontrolled buildings.</summary>
    public List<Building> GetUncontrolledBuildings()
    {
        return buildings.FindAll(b => b.ControllingGuildId == -1);
    }

    /// <summary>Add a building to the collection.</summary>
    public void AddBuilding(Building building)
    {
        if (GetBuilding(building.Id) != null)
            return; // Already exists
        buildings.Add(building);
    }

    /// <summary>Add multiple buildings at once.</summary>
    public void AddBuildings(List<Building> newBuildings)
    {
        buildings.Clear();
        buildings.AddRange(newBuildings);
    }

    /// <summary>Set control of a building.</summary>
    public bool SetBuildingController(int buildingId, int guildId)
    {
        var building = GetBuilding(buildingId);
        if (building == null)
            return false;

        building.ControllingGuildId = guildId;
        return true;
    }

    /// <summary>Upgrade a building to the next level.</summary>
    public bool UpgradeBuilding(int buildingId)
    {
        var building = GetBuilding(buildingId);
        if (building == null)
            return false;

        building.Level++;
        return true;
    }

    /// <summary>Clear all data.</summary>
    public void Clear()
    {
        buildings.Clear();
    }
}

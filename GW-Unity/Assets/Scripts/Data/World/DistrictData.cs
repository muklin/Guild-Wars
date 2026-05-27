using System.Collections.Generic;
using UnityEngine;

/// <summary>
/// Represents a single district region within the city at the city scale.
/// Part of the hierarchical terrain system: World (TerrainData) → City (DistrictData) → Block (BuildingData).
/// </summary>
public class CityDistrict
{
    public int Id { get; set; }
    public Vector3 CenterPosition { get; set; }
    public List<Vector3> Boundary { get; set; }          // Polygon vertices defining district bounds
    public int ControllingGuildId { get; set; } = -1;   // -1 = uncontrolled
    public DistrictClass Class { get; set; }            // Commerce, Military, Religious, etc.
    public string FactionLabel { get; set; }             // Dominant faction in this district

    public CityDistrict()
    {
        Boundary = new();
    }

    public CityDistrict(int id, Vector3 centerPosition) : this()
    {
        Id = id;
        CenterPosition = centerPosition;
    }

    public override string ToString() =>
        $"CityDistrict[{Id}, Class={Class}, Controller={ControllingGuildId}]";
}

/// <summary>
/// Centralized storage for city-scale district organization.
/// Manages subdivisions of the world terrain into playable districts with control, resources, and threats.
/// </summary>
public class DistrictData
{
    private List<CityDistrict> districts = new();
    public IReadOnlyList<CityDistrict> Districts => districts.AsReadOnly();

    public List<CityEdgeData>  CityEdges   { get; } = new();
    public StreetGraph         StreetGraph { get; set; }
    public CityBlockResult     BlockResult { get; set; }

    public int DistrictCount => districts.Count;

    /// <summary>Get a district by ID.</summary>
    public CityDistrict GetDistrict(int id)
    {
        return districts.Find(d => d.Id == id);
    }

    /// <summary>Get all districts.</summary>
    public List<CityDistrict> GetAllDistricts() => new(districts);

    /// <summary>Get all districts controlled by a specific guild.</summary>
    public List<CityDistrict> GetDistrictsControlledBy(int guildId)
    {
        return districts.FindAll(d => d.ControllingGuildId == guildId);
    }

    /// <summary>Get all districts of a specific class.</summary>
    public List<CityDistrict> GetDistrictsByClass(DistrictClass districtClass)
    {
        return districts.FindAll(d => d.Class == districtClass);
    }

    /// <summary>Get all uncontrolled districts.</summary>
    public List<CityDistrict> GetUncontrolledDistricts()
    {
        return districts.FindAll(d => d.ControllingGuildId == -1);
    }

    /// <summary>Add a district to the collection.</summary>
    public void AddDistrict(CityDistrict district)
    {
        if (GetDistrict(district.Id) != null)
            return; // Already exists
        districts.Add(district);
    }

    /// <summary>Add multiple districts at once.</summary>
    public void AddDistricts(List<CityDistrict> newDistricts)
    {
        districts.Clear();
        districts.AddRange(newDistricts);
    }

    /// <summary>Set control of a district.</summary>
    public bool SetDistrictController(int districtId, int guildId)
    {
        var district = GetDistrict(districtId);
        if (district == null)
            return false;

        district.ControllingGuildId = guildId;
        return true;
    }

    /// <summary>Clear all data.</summary>
    public void Clear()
    {
        districts.Clear();
    }
}

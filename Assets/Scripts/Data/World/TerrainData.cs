using System.Collections.Generic;
using UnityEngine;

/// <summary>
/// Represents a single Voronoi region in the terrain at any scale (world, city, block).
/// Pure data class — no MonoBehaviours, no GameObjects. Visualization is kept separate.
/// </summary>
public class VoronoiRegion
{
    public int Id { get; set; }
    public Vector3 SeedPoint { get; set; }              // The Delaunay input point
    public List<Vector3> Polygon { get; set; }          // Voronoi cell vertices (world space, Y=0)
    public TerrainType? AssignedType { get; set; }      // null = unassigned
    public int GridX { get; set; }                      // Nearest grid cell X
    public int GridZ { get; set; }                      // Nearest grid cell Z
    public string Description { get; set; }             // Player-provided description when assigning terrain

    public VoronoiRegion()
    {
        Polygon = new();
    }

    public VoronoiRegion(int id, Vector3 seedPoint, int gridX, int gridZ) : this()
    {
        Id = id;
        SeedPoint = seedPoint;
        GridX = gridX;
        GridZ = gridZ;
    }

    public override string ToString() =>
        $"Region[{Id}, Type={AssignedType}, Pos=({GridX},{GridZ})]";
}

/// <summary>
/// Centralized storage for all terrain region data at a given scale (world, city, or block).
/// Separates data from visualization — VoronoiWorldGenerator uses this to store/query regions,
/// while keeping mesh rendering separate.
/// </summary>
public class TerrainData
{
    private List<VoronoiRegion> regions = new();
    public IReadOnlyList<VoronoiRegion> Regions => regions.AsReadOnly();

    public float WorldSize { get; set; } = 50f;
    public int RegionCount => regions.Count;

    /// <summary>Get a region by ID.</summary>
    public VoronoiRegion GetRegion(int id)
    {
        return regions.Find(r => r.Id == id);
    }

    /// <summary>Get all regions.</summary>
    public List<VoronoiRegion> GetAllRegions() => new(regions);

    /// <summary>Get the nearest region to a world position (by seed point).</summary>
    public VoronoiRegion GetRegionAtWorldPos(Vector3 worldPos)
    {
        if (regions.Count == 0)
            return null;

        VoronoiRegion nearest = regions[0];
        float minDist = Vector3.Distance(worldPos, nearest.SeedPoint);

        for (int i = 1; i < regions.Count; i++)
        {
            float dist = Vector3.Distance(worldPos, regions[i].SeedPoint);
            if (dist < minDist)
            {
                minDist = dist;
                nearest = regions[i];
            }
        }

        return nearest;
    }

    /// <summary>Get all regions with a specific terrain type.</summary>
    public List<VoronoiRegion> GetRegionsByType(TerrainType type)
    {
        return regions.FindAll(r => r.AssignedType == type);
    }

    /// <summary>Get all unassigned (null) regions.</summary>
    public List<VoronoiRegion> GetUnassignedRegions()
    {
        return regions.FindAll(r => r.AssignedType == null);
    }

    /// <summary>Add a region to the collection.</summary>
    public void AddRegion(VoronoiRegion region)
    {
        if (GetRegion(region.Id) != null)
            return; // Already exists
        regions.Add(region);
    }

    /// <summary>Add multiple regions at once (used after Delaunay generation).</summary>
    public void AddRegions(List<VoronoiRegion> newRegions)
    {
        regions.Clear();
        regions.AddRange(newRegions);
    }

    /// <summary>Assign a terrain type to a region.</summary>
    public bool SetRegionTerrain(int regionId, TerrainType type, string description = "")
    {
        var region = GetRegion(regionId);
        if (region == null)
            return false;

        region.AssignedType = type;
        region.Description = description;
        return true;
    }

    /// <summary>Clear all data.</summary>
    public void Clear()
    {
        regions.Clear();
    }
}

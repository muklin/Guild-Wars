using UnityEngine;
using System.Collections.Generic;
using System.Linq;

/// <summary>
/// Stores district positions in 3D space.
/// Maps districts to world positions for city visualization.
/// </summary>
public class CityLayout : MonoBehaviour
{
    [SerializeField] private float districtSpacing = 10f;
    [SerializeField] private int gridWidth = 5;
    [SerializeField] private int gridHeight = 5;

    private Dictionary<int, Vector3> districtPositions = new();
    private Dictionary<int, int> districtGridIndex = new(); // district ID -> grid cell index
    private Dictionary<int, List<TerrainFeature>> terrainByGridCell = new(); // gridIndex -> features

    public void GenerateGridLayout(List<District> districts)
    {
        districtPositions.Clear();
        districtGridIndex.Clear();

        int gridIndex = 0;
        foreach (var district in districts)
        {
            int gridX = gridIndex % gridWidth;
            int gridY = gridIndex / gridWidth;

            Vector3 position = new Vector3(gridX * districtSpacing, 0, gridY * districtSpacing);
            districtPositions[district.Id] = position;
            districtGridIndex[district.Id] = gridIndex;

            district.WorldPosition = position;
            gridIndex++;
        }

        Debug.Log($"City layout generated for {districts.Count} districts in {gridWidth}x{gridHeight} grid");
    }

    public Vector3 GetDistrictPosition(int districtId)
    {
        return districtPositions.ContainsKey(districtId) ? districtPositions[districtId] : Vector3.zero;
    }

    public int? GetDistrictAtGridCell(int x, int z)
    {
        if (x < 0 || x >= gridWidth || z < 0 || z >= gridHeight)
            return null;

        int gridIndex = z * gridWidth + x;
        return districtGridIndex.FirstOrDefault(kvp => kvp.Value == gridIndex).Key;
    }

    public void SetDistrictSpacing(float newSpacing)
    {
        districtSpacing = newSpacing;
    }

    public void SetGridDimensions(int width, int height)
    {
        gridWidth = width;
        gridHeight = height;
    }

    // ==================== TERRAIN ====================

    public void AddTerrainFeature(TerrainFeature feature)
    {
        int gridIndex = feature.GridZ * gridWidth + feature.GridX;
        if (!terrainByGridCell.ContainsKey(gridIndex))
            terrainByGridCell[gridIndex] = new List<TerrainFeature>();
        terrainByGridCell[gridIndex].Add(feature);
    }

    public List<TerrainFeature> GetTerrainAt(int gridX, int gridZ)
    {
        int gridIndex = gridZ * gridWidth + gridX;
        return terrainByGridCell.ContainsKey(gridIndex)
            ? terrainByGridCell[gridIndex]
            : new List<TerrainFeature>();
    }

    public List<TerrainFeature> GetAllTerrainFeatures()
    {
        var all = new List<TerrainFeature>();
        foreach (var list in terrainByGridCell.Values)
            all.AddRange(list);
        return all;
    }
}

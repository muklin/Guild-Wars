using UnityEngine;
using System.Collections.Generic;

/// <summary>
/// Static lookup for terrain type colors.
/// Used by both the Voronoi world generator and the UI panel.
/// </summary>
public static class TerrainColors {
    private static readonly Dictionary<TerrainType, Color> Map = new()
    {
        { TerrainType.Plains,    new Color(0.70f, 0.87f, 0.40f) },      // Pale lime
        { TerrainType.Desert,    new Color(0.93f, 0.79f, 0.45f) },      // Sandy gold
        { TerrainType.Mountains, new Color(0.55f, 0.55f, 0.55f) },      // Stone grey
        { TerrainType.Forest,    new Color(0.13f, 0.55f, 0.13f) },      // Deep green
        { TerrainType.Delta,     new Color(0.40f, 0.75f, 0.60f) },      // Teal-green
        { TerrainType.Sea,       new Color(0.10f, 0.35f, 0.75f) },      // Ocean blue
        { TerrainType.Lake,      new Color(0.10f, 0.35f, 0.75f) },      // Light blue
        { TerrainType.Cliffs,    new Color(0.55f, 0.55f, 0.55f) },      // Grey
        { TerrainType.River,     new Color(0.10f, 0.35f, 0.75f) },      // Blue
        { TerrainType.Hills,     new Color(0.55f, 0.45f, 0.35f) },      // Dark sandy brown
        { TerrainType.Swamp,     new Color(0.20f, 0.50f, 0.20f) },      // Murky green
        { TerrainType.City,      new Color(0.80f, 0.80f, 0.80f) }       // Light Grey - Placeholder - city color is determined by guild colors, but we need a default for the map generator
    };

    public static Color For(TerrainType t) => Map.TryGetValue(t, out var c) ? c : Color.white;

    public static Color Unassigned => new Color(0.72f, 0.65f, 0.50f);  // Dirt/neutral
}

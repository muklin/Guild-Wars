/// <summary>
/// Terrain types for the city's surrounding landscape, placed during Session Zero.
/// </summary>
public enum TerrainType
{
    Desert,
    Mountains,
    Forest,
    River,
    Delta,
    Plains,
    Cliffs,
    Sea,
    Other
}

/// <summary>
/// A terrain feature placed on a map grid tile during Session Zero terrain setup.
/// Each participant places 1-3 features describing the landscape around the city.
/// </summary>
public class TerrainFeature
{
    public TerrainType Type { get; set; }
    public string Description { get; set; }
    public int GridX { get; set; }
    public int GridZ { get; set; }
    public int PlacedByParticipantId { get; set; } // guild/participant ID; -1 = world

    public TerrainFeature(TerrainType type, string description, int gridX, int gridZ, int placedByParticipantId = -1)
    {
        Type = type;
        Description = description;
        GridX = gridX;
        GridZ = gridZ;
        PlacedByParticipantId = placedByParticipantId;
    }

    public override string ToString() => $"{Type} at ({GridX},{GridZ}): \"{Description}\"";
}

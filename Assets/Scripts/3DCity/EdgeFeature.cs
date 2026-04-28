using UnityEngine;
using System.Collections.Generic;

/// <summary>
/// Represents a terrain feature on the edge between two Voronoi regions.
/// Can be Cliffs (1-2 contiguous edges) or Rivers (map-spanning or lake-connected).
/// </summary>
public class EdgeFeature {
    public enum EdgeFeatureType { Cliff, River }

    public int Id;
    public EdgeFeatureType Type;
    public List<(int regionA, int regionB)> Edges; // List of region pairs this feature spans
    public string Description;
    public int CreatedByGuildId;

    public EdgeFeature(int id, EdgeFeatureType type, List<(int, int)> edges, string description, int guildId = 1) {
        Id = id;
        Type = type;
        Edges = new List<(int, int)>(edges);
        Description = description;
        CreatedByGuildId = guildId;
    }

    /// <summary>Checks if this feature is valid based on its type.</summary>
    public bool IsValid() {
        return Type switch {
            EdgeFeatureType.Cliff => ValidateCliff(),
            EdgeFeatureType.River => ValidateRiver(),
            _ => false
        };
    }

    private bool ValidateCliff() {
        // Cliffs must be 1-2 edges
        if (Edges.Count < 1 || Edges.Count > 2) {
            Debug.LogWarning($"Invalid cliff: must have 1-2 edges, has {Edges.Count}");
            return false;
        }

        // If 2 edges, they must be contiguous (share a point)
        if (Edges.Count == 2) {
            var (a1, b1) = Edges[0];
            var (a2, b2) = Edges[1];

            // Check if edges share a point
            bool sharePoint = (a1 == a2 || a1 == b2 || b1 == a2 || b1 == b2);
            if (!sharePoint) {
                Debug.LogWarning("Invalid cliff: edges must be contiguous (share a point)");
                return false;
            }
        }

        return true;
    }

    private bool ValidateRiver() {
        // Rivers must have at least one edge
        if (Edges.Count < 1) {
            Debug.LogWarning("Invalid river: must span at least one edge");
            return false;
        }

        // Validate that edges form a continuous path
        for (int i = 0; i < Edges.Count - 1; i++) {
            var (a1, b1) = Edges[i];
            var (a2, b2) = Edges[i + 1];

            // Adjacent edges must share a region
            bool connected = (a1 == a2 || a1 == b2 || b1 == a2 || b1 == b2);
            if (!connected) {
                Debug.LogWarning($"Invalid river: edges {i} and {i + 1} are not continuous");
                return false;
            }
        }
        // Validate that starting points and ending points are either on the map edge or connected to a lake or sea
        /*Edges.Count switch {
            1 => {
                
            },
            _ => {
                
            }
        };*/


        return true;
    }
}

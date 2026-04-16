using UnityEngine;

/// <summary>
/// Represents a clickable edge between two Voronoi regions.
/// Users can select edges to create cliffs and rivers.
/// Edges are transparent by default, show when hovered or assigned a feature.
/// </summary>
public class VoronoiEdge : MonoBehaviour {
    public int id;
    public int regionA;
    public int regionB;
    public Vector3 edgeStartPoint;
    public Vector3 edgeEndPoint;

    private Material material;
    private MeshRenderer meshRenderer;

    private bool isHovered = false;
    private bool isAssigned = false;
    private TerrainType assignedType;

    private Color normalColor = new Color(0.8f, 0.6f, 0.2f, 0.0f); // Transparent (invisible)
    private Color hoverColor = new Color(1f, 1f, 1f, 1f); // Bright white for hover
    private Color assignedColor; // Will be set based on terrain type

    public void Initialize(int edgeId, int a, int b, Vector3 start, Vector3 end) {
        id = edgeId;
        regionA = a;
        regionB = b;
        edgeStartPoint = start;
        edgeEndPoint = end;

        meshRenderer = GetComponent<MeshRenderer>();
        if (meshRenderer != null) {
            material = meshRenderer.material;
            // Set initial transparent color (invisible until hovered or assigned)
            material.color = normalColor;
        }
    }

    public void Highlight() {
        isHovered = true;
        UpdateColor();
    }

    public void ClearHighlight() {
        isHovered = false;
        UpdateColor();
    }

    public void SetAssignedFeature(TerrainType type) {
        Debug.Log($"[VoronoiEdge] Edge {id} ({regionA}-{regionB}) SetAssignedFeature called with type: {type}");
        isAssigned = true;
        assignedType = type;
        assignedColor = TerrainColors.For(type);
        Debug.Log($"[VoronoiEdge] Edge {id} assigned color: {assignedColor}");
        UpdateColor();
        Debug.Log($"[VoronoiEdge] Edge {id} color updated, isAssigned={isAssigned}");
    }

    private void UpdateColor() {
        if (material == null)
            return;

        // Priority: Assigned > Hovered > Normal (transparent)
        if (isAssigned) {
            // Show full opacity with terrain type color
            material.color = new Color(assignedColor.r, assignedColor.g, assignedColor.b, 1f);

        } else if (isHovered) {
            // Show hover color
            material.color = hoverColor;

        } else {
            // Show transparent
            material.color = normalColor;

        }
    }

    public bool IsAssigned => isAssigned;
}

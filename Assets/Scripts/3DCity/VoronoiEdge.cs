using UnityEngine;

/// <summary>
/// Represents a clickable edge between two Voronoi regions.
/// Users can select edges to create cliffs and rivers.
/// Edges are always visible. They brighten when selected and use terrain type color when assigned a feature.
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
    private bool isSelected = false;
    private bool isAssigned = false;
    private TerrainType assignedType;

    private Color normalColor; // Matches default terrain color
    private Color hoveredColor; // Lightened version of normal
    private Color selectedColor = new Color(1f, 1f, 1f, 1f); // Bright white for selection
    private Color assignedColor; // Will be set based on terrain type

    public void Initialize(int edgeId, int a, int b, Vector3 start, Vector3 end) {
        id = edgeId;
        regionA = a;
        regionB = b;
        edgeStartPoint = start;
        edgeEndPoint = end;

        // Set colors based on default terrain color
        normalColor = TerrainColors.Unassigned;
        hoveredColor = LightenColor(normalColor, 0.3f);

        meshRenderer = GetComponent<MeshRenderer>();
        if (meshRenderer != null) {
            material = meshRenderer.material;
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

    public void Select() {
        isSelected = true;
        UpdateColor();
    }

    public void Deselect() {
        isSelected = false;
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

    public void SetTerrainColor(TerrainType type) {
        assignedType = type;
        assignedColor = TerrainColors.For(type);
        UpdateColor();
    }

    private void UpdateColor() {
        if (material == null)
            return;

        // Priority: Selected > Hovered > Assigned > Normal
        if (isSelected) {
            material.color = selectedColor;
        } else if (isHovered) {
            if (isAssigned) {
                material.color = LightenColor(assignedColor, 0.3f);
            } else {
                material.color = hoveredColor;
            }
        } else if (isAssigned) {
            material.color = new Color(assignedColor.r, assignedColor.g, assignedColor.b, 1f);
        } else {
            material.color = normalColor;
        }
    }

    private Color LightenColor(Color color, float amount) {
        return new Color(
            Mathf.Min(color.r + amount, 1f),
            Mathf.Min(color.g + amount, 1f),
            Mathf.Min(color.b + amount, 1f),
            color.a
        );
    }

    public bool IsAssigned => isAssigned;
}

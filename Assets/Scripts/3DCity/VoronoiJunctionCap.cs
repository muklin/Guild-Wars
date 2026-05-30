using UnityEngine;
using System.Collections.Generic;

/// <summary>
/// Fills the gap at Voronoi junction vertices where 3+ boundary edges meet.
/// Mirrors the selection/hover/assignment color of its adjacent edges each frame.
/// </summary>
public class VoronoiJunctionCap : MonoBehaviour {
    private List<VoronoiEdge> adjacentEdges = new();
    private Material material;
    private Color normalColor;
    private static readonly Color SelectedColor = new Color(1f, 1f, 1f, 1f);

    public void Initialize(List<VoronoiEdge> edges, Color normal) {
        adjacentEdges = new List<VoronoiEdge>(edges);
        normalColor = normal;
        material = GetComponent<MeshRenderer>().material;
        material.color = normalColor;
    }

    private void Update() {
        if (material == null) return;

        bool anySelected = false;
        foreach (var edge in adjacentEdges) {
            if (edge != null && edge.IsSelected) { anySelected = true; break; }
        }

        if (anySelected) {
            material.color = SelectedColor;
            return;
        }

        // Mirror first hovered or assigned edge color, else normal
        Color target = normalColor;
        foreach (var edge in adjacentEdges) {
            if (edge != null && (edge.IsHovered || edge.IsAssigned)) {
                target = edge.CurrentColor;
                break;
            }
        }
        material.color = target;
    }
}

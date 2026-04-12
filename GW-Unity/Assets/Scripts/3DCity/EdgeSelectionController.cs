using UnityEngine;
using UnityEngine.InputSystem;
using System.Collections.Generic;

/// <summary>
/// Handles selection of region edges for creating cliffs and rivers.
/// Allows users to select 1-2 contiguous edges for cliffs, or continuous edges for rivers.
/// </summary>
public class EdgeSelectionController : MonoBehaviour
{
    public static bool IsActive { get; private set; }

    private VoronoiWorldGenerator worldGen;
    private SessionZeroPhase sessionZero;
    private Camera mainCamera;
    private List<VoronoiEdge> selectedEdges = new();
    private EdgeFeature.EdgeFeatureType currentFeatureType = EdgeFeature.EdgeFeatureType.Cliff;

    public void Initialize(VoronoiWorldGenerator worldGen, SessionZeroPhase sessionZero, Camera mainCamera)
    {
        this.worldGen = worldGen;
        this.sessionZero = sessionZero;
        this.mainCamera = mainCamera;
        IsActive = false;
    }

    public void BeginEdgeSelection()
    {
        IsActive = true;
        selectedEdges.Clear();
        Debug.Log("Edge selection mode activated. Click edges to select (Cliffs: 1-2 edges, Rivers: continuous)");
    }

    public void EndEdgeSelection()
    {
        IsActive = false;
        ClearEdgeSelection();
    }

    public void SetFeatureType(EdgeFeature.EdgeFeatureType type)
    {
        currentFeatureType = type;
        Debug.Log($"Edge feature type set to: {type}");
    }

    private void Update()
    {
        if (!IsActive) return;

        var mouse = Mouse.current;
        if (mouse == null) return;

        if (mouse.leftButton.wasPressedThisFrame)
        {
            HandleEdgeSelection();
        }

        // Right-click to deselect last edge
        if (mouse.rightButton.wasPressedThisFrame)
        {
            if (selectedEdges.Count > 0)
            {
                var lastEdge = selectedEdges[selectedEdges.Count - 1];
                worldGen.ClearEdgeHighlight(lastEdge);
                selectedEdges.RemoveAt(selectedEdges.Count - 1);
                Debug.Log($"Deselected edge {lastEdge.id}");
            }
        }
    }

    private void HandleEdgeSelection()
    {
        var ray = mainCamera.ScreenPointToRay(Mouse.current.position.ReadValue());

        if (Physics.Raycast(ray, out RaycastHit hit, 1000f))
        {
            var edgeComponent = hit.collider.GetComponent<VoronoiEdge>();
            if (edgeComponent != null)
            {
                if (selectedEdges.Contains(edgeComponent))
                {
                    // Deselect
                    selectedEdges.Remove(edgeComponent);
                    worldGen.ClearEdgeHighlight(edgeComponent);
                    Debug.Log($"Deselected edge {edgeComponent.id}");
                }
                else
                {
                    // Validate selection based on type
                    if (CanSelectEdge(edgeComponent))
                    {
                        selectedEdges.Add(edgeComponent);
                        worldGen.HighlightEdge(edgeComponent);
                        Debug.Log($"Selected edge {edgeComponent.id} between regions {edgeComponent.regionA} and {edgeComponent.regionB}");
                    }
                }
            }
        }
    }

    private bool CanSelectEdge(VoronoiEdge edge)
    {
        if (currentFeatureType == EdgeFeature.EdgeFeatureType.Cliff)
        {
            // Cliffs: max 2 edges, must be contiguous
            if (selectedEdges.Count >= 2)
            {
                Debug.LogWarning("Cliffs can only span 1-2 edges");
                return false;
            }

            if (selectedEdges.Count == 1)
            {
                // Check contiguity: edges must share exactly one vertex
                if (!EdgesAreContiguous(selectedEdges[0], edge))
                {
                    Debug.LogWarning("Cliff edges must be contiguous (share a vertex)");
                    return false;
                }
            }
        }
        else if (currentFeatureType == EdgeFeature.EdgeFeatureType.River)
        {
            // Rivers: must form continuous line
            if (selectedEdges.Count > 0)
            {
                var lastEdge = selectedEdges[selectedEdges.Count - 1];
                // Check if new edge connects to the last selected edge
                if (!EdgesAreContiguous(lastEdge, edge))
                {
                    Debug.LogWarning("River edges must form a continuous line");
                    return false;
                }
            }
        }

        return true;
    }

    private bool EdgesAreContiguous(VoronoiEdge edge1, VoronoiEdge edge2)
    {
        // Two edges are contiguous if they share at least one vertex
        const float tolerance = 0.1f;

        // Check if any vertex of edge1 matches any vertex of edge2
        return (Vector3.Distance(edge1.edgeStartPoint, edge2.edgeStartPoint) < tolerance ||
                Vector3.Distance(edge1.edgeStartPoint, edge2.edgeEndPoint) < tolerance ||
                Vector3.Distance(edge1.edgeEndPoint, edge2.edgeStartPoint) < tolerance ||
                Vector3.Distance(edge1.edgeEndPoint, edge2.edgeEndPoint) < tolerance);
    }

    public bool TryCreateFeature(string description)
    {
        if (selectedEdges.Count == 0)
        {
            Debug.LogWarning("No edges selected");
            return false;
        }

        // Convert selected edges to region pairs
        var edges = new List<(int, int)>();
        foreach (var edge in selectedEdges)
        {
            edges.Add((edge.regionA, edge.regionB));
        }

        // Validate feature-specific rules
        if (!ValidateFeature(edges))
            return false;

        // Add to world generator
        bool success = worldGen.AddEdgeFeature(edges, currentFeatureType, description);

        if (success)
        {
            ClearEdgeSelection();
        }

        return success;
    }

    private bool ValidateFeature(List<(int, int)> edges)
    {
        if (currentFeatureType == EdgeFeature.EdgeFeatureType.Cliff)
        {
            // Cliffs: 1-2 edges, must be contiguous (already validated during selection)
            if (edges.Count < 1 || edges.Count > 2)
            {
                Debug.LogWarning("Cliffs must span 1-2 contiguous edges");
                return false;
            }
            return true;
        }
        else if (currentFeatureType == EdgeFeature.EdgeFeatureType.River)
        {
            // Rivers: must span from map edge to edge, or connect to lakes
            if (edges.Count < 1)
            {
                Debug.LogWarning("Rivers must span at least one edge");
                return false;
            }

            // Get the start and end edges
            var startEdge = selectedEdges[0];
            var endEdge = selectedEdges[selectedEdges.Count - 1];

            // Check if river spans from map edge to map edge
            bool startsAtMapEdge = IsEdgeAtMapBoundary(startEdge);
            bool endsAtMapEdge = IsEdgeAtMapBoundary(endEdge);

            if (startsAtMapEdge && endsAtMapEdge)
            {
                Debug.Log($"River spans from map edge to map edge ✓");
                return true;
            }

            // Check if connected to lakes (TODO: implement when lake system is in place)
            // For now, only accept map-edge-to-edge rivers
            Debug.LogWarning("Rivers must span from one map edge to another (lake connection not yet implemented)");
            return false;
        }

        return true;
    }

    private bool IsEdgeAtMapBoundary(VoronoiEdge edge)
    {
        const float margin = 0.5f;
        const float worldSize = 50f;

        // Check if edge touches the map boundary
        var points = new[] { edge.edgeStartPoint, edge.edgeEndPoint };

        foreach (var point in points)
        {
            // Check all four boundaries
            if (point.x < margin || point.x > (worldSize - margin) ||
                point.z < margin || point.z > (worldSize - margin))
            {
                return true;
            }
        }

        return false;
    }

    private void ClearEdgeSelection()
    {
        foreach (var edge in selectedEdges)
        {
            worldGen.ClearEdgeHighlight(edge);
        }
        selectedEdges.Clear();
    }

    public List<VoronoiEdge> GetSelectedEdges() => new List<VoronoiEdge>(selectedEdges);
}

using UnityEngine;
using UnityEngine.InputSystem;
using UnityEngine.EventSystems;
using System.Collections.Generic;

/// <summary>
/// Handles selection of region edges for creating cliffs and rivers.
/// Allows users to select 1-2 contiguous edges for cliffs, or continuous edges for rivers.
/// </summary>
public class EdgeSelectionController : MonoBehaviour {
    public static bool IsActive { get; private set; }

    private VoronoiWorldGenerator worldGen;
    private SetupPhase SetupPhase;
    private Camera mainCamera;
    private TerrainTypePanel terrainPanel;
    private List<VoronoiEdge> selectedEdges = new();
    private EdgeFeature.EdgeFeatureType currentFeatureType = EdgeFeature.EdgeFeatureType.Cliff;
    private Vector3 chainStartPoint = Vector3.zero;
    private Vector3 chainEndPoint = Vector3.zero;
    private VoronoiEdge hoveredEdge;

    public void Initialize(VoronoiWorldGenerator worldGen, SetupPhase SetupPhase, Camera mainCamera, TerrainTypePanel terrainPanel = null) {
        this.worldGen = worldGen;
        this.SetupPhase = SetupPhase;
        this.mainCamera = mainCamera;
        this.terrainPanel = terrainPanel;
        IsActive = false;
    }

    public void BeginEdgeSelection() {
        IsActive = true;
        selectedEdges.Clear();
    }

    public void EndEdgeSelection() {
        IsActive = false;
        ClearEdgeSelection();
    }

    public void SetFeatureType(EdgeFeature.EdgeFeatureType type) {
        currentFeatureType = type;
        Debug.Log($"Edge feature type set to: {type}");
    }

    private void Update() {
        if (!IsActive) {
            return;
        }

        var mouse = Mouse.current;
        if (mouse == null) {
            return;
        }

        // Update hover effect
        UpdateHover();

        if (mouse.leftButton.wasPressedThisFrame) {
            // Don't select edges if clicking over the panel
            var terrainPanel = FindAnyObjectByType<TerrainTypePanel>();
            if (terrainPanel != null && terrainPanel.IsClickOverPanel(mouse.position.ReadValue())) {
                Debug.Log("[EdgeSelectionController] Click over panel, ignoring edge selection");
                return;
            }
            HandleEdgeSelection();
        }

        // Right-click to deselect last edge
        if (mouse.rightButton.wasPressedThisFrame) {
            if (selectedEdges.Count > 0) {
                var lastEdge = selectedEdges[selectedEdges.Count - 1];
                lastEdge.Deselect();
                selectedEdges.RemoveAt(selectedEdges.Count - 1);

                // Update UI button visibility when edge count changes
                if (terrainPanel != null) {
                    terrainPanel.UpdateEdgeButtonVisibility();
                }
            }
        }
    }

    private void UpdateHover() {
        var ray = mainCamera.ScreenPointToRay(Mouse.current.position.ReadValue());
        VoronoiEdge hoveredNow = null;

        // Check all hits, sorted by distance, looking for edges first
        RaycastHit[] hits = Physics.RaycastAll(ray, 1000f);

        // Sort by distance so closest hits are checked first
        System.Array.Sort(hits, (a, b) => a.distance.CompareTo(b.distance));

        foreach (var hit in hits) {
            var edgeComponent = hit.collider.GetComponent<VoronoiEdge>();
            if (edgeComponent != null) {
                hoveredNow = edgeComponent;
                break;
            }
        }

        // Track hovered edge for hover highlighting
        if (hoveredNow != null && !selectedEdges.Contains(hoveredNow)) {
            hoveredNow.Highlight();
        }

        // Clear hover from previously hovered edge if no longer hovered
        foreach (var edge in worldGen.Edges) {
            if (edge != hoveredNow && !selectedEdges.Contains(edge)) {
                edge.ClearHighlight();
            }
        }
    }

    private void HandleEdgeSelection() {
        var ray = mainCamera.ScreenPointToRay(Mouse.current.position.ReadValue());

        // Check all hits and look for an edge component
        RaycastHit[] hits = Physics.RaycastAll(ray, 1000f);

        // Sort by distance
        System.Array.Sort(hits, (a, b) => a.distance.CompareTo(b.distance));

        foreach (var hit in hits) {
            var edgeComponent = hit.collider.GetComponent<VoronoiEdge>();
            if (edgeComponent != null) {
                Debug.Log($"[EdgeSelectionController] Hit edge {edgeComponent.id}, already selected: {selectedEdges.Contains(edgeComponent)}");

                if (selectedEdges.Contains(edgeComponent)) {
                    // Deselect
                    Debug.Log($"[EdgeSelectionController] BEFORE deselect: selectedEdges = [{string.Join(", ", selectedEdges.ConvertAll(e => e.id.ToString()))}]");
                    selectedEdges.Remove(edgeComponent);
                    edgeComponent.Deselect();
                    Debug.Log($"[EdgeSelectionController] Deselected edge {edgeComponent.id}, now have {selectedEdges.Count} edges selected");
                    Debug.Log($"[EdgeSelectionController] AFTER deselect: selectedEdges = [{string.Join(", ", selectedEdges.ConvertAll(e => e.id.ToString()))}]");

                    // Update UI button visibility when edge count changes
                    if (terrainPanel != null) {
                        terrainPanel.UpdateEdgeButtonVisibility();
                    }
                } else {
                    // Validate selection based on type
                    if (CanSelectEdge(edgeComponent)) {
                        bool wasFirstEdge = selectedEdges.Count == 0;
                        Debug.Log($"[EdgeSelectionController] BEFORE add: selectedEdges = [{string.Join(", ", selectedEdges.ConvertAll(e => e.id.ToString()))}]");

                        // Insert edge at start or end of chain based on which endpoint it connects to
                        if (wasFirstEdge) {
                            selectedEdges.Add(edgeComponent);
                            chainStartPoint = edgeComponent.edgeStartPoint;
                            chainEndPoint = edgeComponent.edgeEndPoint;
                        } else {
                            bool connectsToStart = VerticesMatch(edgeComponent.edgeStartPoint, chainStartPoint) ||
                                                 VerticesMatch(edgeComponent.edgeEndPoint, chainStartPoint);

                            if (connectsToStart) {
                                // Prepend to start of chain and update chainStartPoint
                                selectedEdges.Insert(0, edgeComponent);
                                // Update chainStartPoint to the other end of this edge
                                chainStartPoint = VerticesMatch(edgeComponent.edgeStartPoint, chainStartPoint) ?
                                    edgeComponent.edgeEndPoint : edgeComponent.edgeStartPoint;
                            } else {
                                // Append to end of chain and update chainEndPoint
                                selectedEdges.Add(edgeComponent);
                                // Update chainEndPoint to the other end of this edge
                                chainEndPoint = VerticesMatch(edgeComponent.edgeStartPoint, chainEndPoint) ?
                                    edgeComponent.edgeEndPoint : edgeComponent.edgeStartPoint;
                            }
                        }

                        edgeComponent.Select();
                        Debug.Log($"[EdgeSelectionController] Selected edge {edgeComponent.id} between regions {edgeComponent.regionA} and {edgeComponent.regionB}, now have {selectedEdges.Count} edges selected");
                        Debug.Log($"[EdgeSelectionController] AFTER add: selectedEdges = [{string.Join(", ", selectedEdges.ConvertAll(e => e.id.ToString()))}]");

                        // Notify UI to switch to edge mode when first edge is selected
                        if (wasFirstEdge && terrainPanel != null) {
                            terrainPanel.OnEdgeSelected();
                        }

                        // Update UI button visibility when edge count changes
                        if (terrainPanel != null) {
                            terrainPanel.UpdateEdgeButtonVisibility();
                        }
                    } else {
                        Debug.Log($"[EdgeSelectionController] Cannot select edge {edgeComponent.id} - validation failed");
                    }
                }
                return;
            }
        }
    }

    private bool CanSelectEdge(VoronoiEdge edge) {
        // Prevent selecting already-assigned edges
        if (edge.IsAssigned) {
            Debug.LogWarning($"Edge {edge.id} is already assigned a feature and cannot be selected");
            return false;
        }

        // Prevent selecting edges already in the chain
        if (selectedEdges.Contains(edge)) {
            Debug.LogWarning($"Edge {edge.id} is already selected");
            return false;
        }

        // Allow selecting edges without restriction during selection
        // Validation happens when user chooses feature type and applies
        if (selectedEdges.Count > 0) {
            // Check if edge connects to either endpoint of the chain
            bool connectsToStart = VerticesMatch(edge.edgeStartPoint, chainStartPoint) ||
                                 VerticesMatch(edge.edgeEndPoint, chainStartPoint);
            bool connectsToEnd = VerticesMatch(edge.edgeStartPoint, chainEndPoint) ||
                               VerticesMatch(edge.edgeEndPoint, chainEndPoint);

            if (!connectsToStart && !connectsToEnd) {
                Debug.LogWarning("Edges must form a continuous line (share vertices)");
                return false;
            }
        }

        return true;
    }

    private bool EdgesAreContiguous(VoronoiEdge edge1, VoronoiEdge edge2) {
        // Two edges are contiguous if they share at least one vertex
        const float tolerance = 0.1f;

        // Check if any vertex of edge1 matches any vertex of edge2
        return (Vector3.Distance(edge1.edgeStartPoint, edge2.edgeStartPoint) < tolerance ||
                Vector3.Distance(edge1.edgeStartPoint, edge2.edgeEndPoint) < tolerance ||
                Vector3.Distance(edge1.edgeEndPoint, edge2.edgeStartPoint) < tolerance ||
                Vector3.Distance(edge1.edgeEndPoint, edge2.edgeEndPoint) < tolerance);
    }

    private bool VerticesMatch(Vector3 v1, Vector3 v2) {
        const float tolerance = 0.1f;
        return Vector3.Distance(v1, v2) < tolerance;
    }

    public bool TryCreateFeature(string description) {
        Debug.Log($"[EdgeSelectionController] TryCreateFeature called with {selectedEdges.Count} edges, type: {currentFeatureType}, description: '{description}'");

        if (selectedEdges.Count == 0) {
            Debug.LogWarning("No edges selected");
            return false;
        }

        // Convert selected edges to region pairs
        var edges = new List<(int, int)>();
        foreach (var edge in selectedEdges) {
            edges.Add((edge.regionA, edge.regionB));
            Debug.Log($"[EdgeSelectionController] Edge {edge.regionA}-{edge.regionB}");
        }

        // Validate feature-specific rules
        if (!ValidateFeature(edges)) {
            Debug.Log("[EdgeSelectionController] Feature validation failed");
            return false;
        }

        // Add to world generator
        Debug.Log($"[EdgeSelectionController] Calling AddEdgeFeature with {edges.Count} edges");
        bool success = worldGen.AddEdgeFeature(edges, currentFeatureType, description);
        Debug.Log($"[EdgeSelectionController] AddEdgeFeature returned: {success}");

        if (success) {
            Debug.Log("[EdgeSelectionController] Clearing edge selection");
            ClearEdgeSelection();
        }

        return success;
    }

    private bool ValidateFeature(List<(int, int)> edges) {
        if (currentFeatureType == EdgeFeature.EdgeFeatureType.Cliff) {
            // Cliffs: 1-2 edges, must be contiguous (already validated during selection)
            if (edges.Count < 1 || edges.Count > 2) {
                string message = "Cliffs must span 1-2 contiguous edges";
                Debug.LogWarning(message);
                UIManager.Instance?.ShowError(message);
                return false;
            }
            return true;
        } else if (currentFeatureType == EdgeFeature.EdgeFeatureType.River) {
            // Rivers: must span from map edge to edge, or connect to lakes
            if (edges.Count < 1) {
                string message = "Rivers must span at least one edge";
                Debug.LogWarning(message);
                UIManager.Instance?.ShowError(message);
                return false;
            }

            // Get the start and end edges
            var startEdge = selectedEdges[0];
            var endEdge = selectedEdges[selectedEdges.Count - 1];

            // Check if river spans from map edge to map edge
            bool startsAtMapEdge = IsEdgeAtMapBoundary(startEdge);
            bool endsAtMapEdge = IsEdgeAtMapBoundary(endEdge);

            if (startsAtMapEdge && endsAtMapEdge) {
                Debug.Log($"River spans from map edge to map edge ✓");
                return true;
            }

            // Check if connected to lakes (TODO: implement when lake system is in place)
            // For now, only accept map-edge-to-edge rivers
            string errorMessage = "Rivers must span from one map edge to another (lake connection not yet implemented)";
            Debug.LogWarning(errorMessage);
            UIManager.Instance?.ShowError(errorMessage);
            return false;
        }

        return true;
    }

    private bool IsEdgeAtMapBoundary(VoronoiEdge edge) {
        const float margin = 0.5f;
        const float worldSize = 50f;

        // Check if edge touches the map boundary
        var points = new[] { edge.edgeStartPoint, edge.edgeEndPoint };

        foreach (var point in points) {
            // Check all four boundaries
            if (point.x < margin || point.x > (worldSize - margin) ||
                point.z < margin || point.z > (worldSize - margin)) {
                return true;
            }
        }

        return false;
    }

    private void ClearEdgeSelection() {
        foreach (var edge in selectedEdges) {
            edge.Deselect();
        }
        selectedEdges.Clear();
        chainStartPoint = Vector3.zero;
        chainEndPoint = Vector3.zero;
    }

    public List<VoronoiEdge> GetSelectedEdges() => new List<VoronoiEdge>(selectedEdges);

    public void DeselectAllEdges() {
        ClearEdgeSelection();
    }
}

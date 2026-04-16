using UnityEngine;
using UnityEngine.InputSystem;
using UnityEngine.EventSystems;
using System.Linq;

/// <summary>
/// Handles click-to-select-region input during terrain setup.
/// When user clicks a region, highlights it and stores selection.
/// When UI calls AssignTerrain, records the placement and fires the SetupPhase event.
/// </summary>
public class TerrainSelectionController : MonoBehaviour {
    public static bool IsActive { get; private set; }

    private VoronoiWorldGenerator worldGen;
    private SetupPhase SetupPhase;
    private Camera mainCamera;
    private TerrainTypePanel terrainPanel;
    private VoronoiRegion selectedRegion;
    private VoronoiRegion hoveredRegion;

    public void Initialize(VoronoiWorldGenerator worldGen, SetupPhase SetupPhase, Camera mainCamera, TerrainTypePanel terrainPanel = null) {
        this.worldGen = worldGen;
        this.SetupPhase = SetupPhase;
        this.mainCamera = mainCamera;
        this.terrainPanel = terrainPanel;
        IsActive = false;
    }

    public void BeginTerrainSelection() {
        IsActive = true;
        selectedRegion = null;
        Debug.Log("Terrain selection mode activated. Click a region to select.");
    }

    public void EndTerrainSelection() {
        IsActive = false;
        if (selectedRegion != null)
            worldGen.ClearHighlight(selectedRegion.Id);
        selectedRegion = null;
    }

    private void Update() {
        if (!IsActive)
            return;

        var mouse = Mouse.current;
        if (mouse == null)
            return;

        // Update hover effect
        UpdateHover();

        if (mouse.leftButton.wasPressedThisFrame) {
            // Don't select regions if clicking over the panel
            var terrainPanel = FindAnyObjectByType<TerrainTypePanel>();
            if (terrainPanel != null && terrainPanel.IsClickOverPanel(mouse.position.ReadValue())) {
                Debug.Log("[TerrainSelectionController] Click over panel, ignoring region selection");
                return;
            }
            HandleRegionSelection();
        }
    }

    private void UpdateHover() {
        var mouse = Mouse.current;
        var ray = mainCamera.ScreenPointToRay(mouse.position.ReadValue());
        var plane = new Plane(Vector3.up, Vector3.zero);

        VoronoiRegion hoveredNow = null;

        if (plane.Raycast(ray, out float dist)) {
            Vector3 hitPoint = ray.origin + ray.direction * dist;
            hitPoint.x = Mathf.Clamp(hitPoint.x, 0, 50f);
            hitPoint.z = Mathf.Clamp(hitPoint.z, 0, 50f);

            var region = worldGen.GetRegionAtWorldPos(hitPoint);
            if (region != null && region != selectedRegion)
                hoveredNow = region;
        }

        // Update visuals if hover changed
        if (hoveredNow != hoveredRegion) {
            if (hoveredRegion != null && hoveredRegion != selectedRegion)
                worldGen.ClearHighlight(hoveredRegion.Id);

            hoveredRegion = hoveredNow;

            if (hoveredRegion != null)
                worldGen.HighlightRegion(hoveredRegion.Id);
        }
    }

    private void HandleRegionSelection() {
        var mouse = Mouse.current;
        if (mouse == null)
            return;

        // Don't select regions if edges are already selected (stay in edge mode)
        var edgeController = FindAnyObjectByType<EdgeSelectionController>();
        if (edgeController != null && edgeController.GetSelectedEdges().Count > 0) {
            Debug.Log("[TerrainSelectionController] Edges already selected, ignoring region selection");
            return;
        }

        var ray = mainCamera.ScreenPointToRay(mouse.position.ReadValue());
        var plane = new Plane(Vector3.up, Vector3.zero);

        if (plane.Raycast(ray, out float dist)) {
            Vector3 hitPoint = ray.origin + ray.direction * dist;

            // Clamp to world bounds
            hitPoint.x = Mathf.Clamp(hitPoint.x, 0, 50f);
            hitPoint.z = Mathf.Clamp(hitPoint.z, 0, 50f);

            var region = worldGen.GetRegionAtWorldPos(hitPoint);
            if (region != null) {
                // Prevent selecting the city region (it's pre-assigned as City terrain)
                if (region.AssignedType == TerrainType.City) {
                    Debug.Log("[TerrainSelectionController] Cannot select city region — it is locked");
                    return;
                }

                if (selectedRegion != null && selectedRegion.Id != region.Id) {
                    worldGen.ClearHighlight(selectedRegion.Id);
                }
                selectedRegion = region;
                worldGen.HighlightRegion(region.Id);

                // Notify UI to switch to region mode
                if (terrainPanel != null) {
                    terrainPanel.OnRegionSelected();
                }
                //Debug.Log($"Selected region {region.Id} at seed {region.SeedPoint}");
            }
        }
    }

    public void AssignTerrain(TerrainType type, string description) {
        if (selectedRegion == null) {
            Debug.LogWarning("No region selected. Cannot assign terrain.");
            return;
        }

        // Validate boundary constraint
        if ((type == TerrainType.Sea || type == TerrainType.Mountains) && !IsBoundaryRegion(selectedRegion)) {
            Debug.LogWarning($"{type} can only be assigned to edge regions. Selected region is interior.");
            return;
        }

        worldGen.SetRegionTerrain(selectedRegion.Id, type);
        SetupPhase.PlaceTerrainFeature(type, description, selectedRegion.GridX, selectedRegion.GridZ);

        worldGen.ClearHighlight(selectedRegion.Id);
        selectedRegion = null;

        Debug.Log($"Assigned terrain {type} to region");
    }

    private bool IsBoundaryRegion(VoronoiRegion region) {
        const float margin = 0.5f;
        return region.Polygon.Any(v =>
            v.x < margin || v.x > (50f - margin) ||
            v.z < margin || v.z > (50f - margin)
        );
    }

    public VoronoiRegion GetSelectedRegion() => selectedRegion;

    public void DeselectRegion() {
        if (selectedRegion != null) {
            worldGen.ClearHighlight(selectedRegion.Id);
        }
        selectedRegion = null;
    }
}

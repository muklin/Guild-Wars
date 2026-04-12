using UnityEngine;
using UnityEngine.InputSystem;
using System.Linq;

/// <summary>
/// Handles click-to-select-region input during terrain setup.
/// When user clicks a region, highlights it and stores selection.
/// When UI calls AssignTerrain, records the placement and fires the SessionZeroPhase event.
/// </summary>
public class TerrainSelectionController : MonoBehaviour
{
    public static bool IsActive { get; private set; }

    private VoronoiWorldGenerator worldGen;
    private SessionZeroPhase sessionZero;
    private Camera mainCamera;
    private VoronoiWorldGenerator.VoronoiRegion selectedRegion;

    public void Initialize(VoronoiWorldGenerator worldGen, SessionZeroPhase sessionZero, Camera mainCamera)
    {
        this.worldGen = worldGen;
        this.sessionZero = sessionZero;
        this.mainCamera = mainCamera;
        IsActive = false;
    }

    public void BeginTerrainSelection()
    {
        IsActive = true;
        selectedRegion = null;
        Debug.Log("Terrain selection mode activated. Click a region to select.");
    }

    public void EndTerrainSelection()
    {
        IsActive = false;
        if (selectedRegion != null)
            worldGen.ClearHighlight(selectedRegion.Id);
        selectedRegion = null;
    }

    private void Update()
    {
        if (!IsActive) return;

        var mouse = Mouse.current;
        if (mouse == null) return;

        if (mouse.leftButton.wasPressedThisFrame)
        {
            HandleRegionSelection();
        }
    }

    private void HandleRegionSelection()
    {
        var mouse = Mouse.current;
        if (mouse == null) return;

        var ray = mainCamera.ScreenPointToRay(mouse.position.ReadValue());
        var plane = new Plane(Vector3.up, Vector3.zero);

        if (plane.Raycast(ray, out float dist))
        {
            Vector3 hitPoint = ray.origin + ray.direction * dist;

            // Clamp to world bounds
            hitPoint.x = Mathf.Clamp(hitPoint.x, 0, 50f);
            hitPoint.z = Mathf.Clamp(hitPoint.z, 0, 50f);

            var region = worldGen.GetRegionAtWorldPos(hitPoint);
            if (region != null)
            {
                if (selectedRegion != null && selectedRegion.Id != region.Id)
                {
                    worldGen.ClearHighlight(selectedRegion.Id);
                }
                selectedRegion = region;
                worldGen.HighlightRegion(region.Id);
                Debug.Log($"Selected region {region.Id} at seed {region.SeedPoint}");
            }
        }
    }

    public void AssignTerrain(TerrainType type, string description)
    {
        if (selectedRegion == null)
        {
            Debug.LogWarning("No region selected. Cannot assign terrain.");
            return;
        }

        // Validate boundary constraint
        if ((type == TerrainType.Sea || type == TerrainType.Mountains) && !IsBoundaryRegion(selectedRegion))
        {
            Debug.LogWarning($"{type} can only be assigned to edge regions. Selected region is interior.");
            return;
        }

        worldGen.SetRegionTerrain(selectedRegion.Id, type);
        sessionZero.PlaceTerrainFeature(type, description, selectedRegion.GridX, selectedRegion.GridZ);

        worldGen.ClearHighlight(selectedRegion.Id);
        selectedRegion = null;

        Debug.Log($"Assigned terrain {type} to region");
    }

    private bool IsBoundaryRegion(VoronoiWorldGenerator.VoronoiRegion region)
    {
        const float margin = 0.5f;
        return region.Polygon.Any(v =>
            v.x < margin || v.x > (50f - margin) ||
            v.z < margin || v.z > (50f - margin)
        );
    }

    public VoronoiWorldGenerator.VoronoiRegion GetSelectedRegion() => selectedRegion;
}

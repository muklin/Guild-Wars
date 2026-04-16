using UnityEngine;
using UnityEngine.InputSystem;
using UnityEngine.EventSystems;
using System.Collections.Generic;

/// <summary>
/// Handles selection of city districts for classification.
/// Allows users to click on districts and assign DistrictClass types.
/// </summary>
public class CityDistrictSelectionController : MonoBehaviour {
    public static bool IsActive { get; private set; }

    private CityVoronoiGenerator generator;
    private SetupPhase setupPhase;
    private Camera mainCamera;
    private DistrictTypePanel districtPanel;
    private CityDistrict selectedDistrict;
    private CityDistrict hoveredDistrict;

    public void Initialize(CityVoronoiGenerator generator, SetupPhase setupPhase, Camera mainCamera, DistrictTypePanel districtPanel = null) {
        this.generator = generator;
        this.setupPhase = setupPhase;
        this.mainCamera = mainCamera;
        this.districtPanel = districtPanel;
        IsActive = false;
    }

    public void BeginDistrictSelection() {
        IsActive = true;
        Debug.Log("[CityDistrictSelectionController] District selection enabled");
    }

    public void EndDistrictSelection() {
        IsActive = false;
        ClearDistrictSelection();
        Debug.Log("[CityDistrictSelectionController] District selection disabled");
    }

    public void AssignDistrictClass(DistrictClass cls, string description) {
        if (selectedDistrict == null) {
            Debug.LogWarning("[CityDistrictSelectionController] No district selected");
            return;
        }

        generator.SetDistrictClass(selectedDistrict.Id, cls);
        setupPhase.RecordDistrictClassAssignment(selectedDistrict.Id, cls);
        DeselectDistrict();
    }

    public CityDistrict GetSelectedDistrict() => selectedDistrict;

    public void DeselectDistrict() {
        if (selectedDistrict != null) {
            generator.ClearHighlight(selectedDistrict.Id);
        }
        selectedDistrict = null;
    }

    private void Update() {
        if (!IsActive)
            return;

        var mouse = Mouse.current;
        if (mouse == null)
            return;

        // Update hover effect
        UpdateHover();

        // Left-click to select
        if (mouse.leftButton.wasPressedThisFrame) {
            // Don't select if clicking over the panel
            if (districtPanel != null && districtPanel.IsClickOverPanel(mouse.position.ReadValue())) {
                Debug.Log("[CityDistrictSelectionController] Click over panel, ignoring district selection");
                return;
            }
            HandleDistrictSelection();
        }
    }

    private void UpdateHover() {
        var ray = mainCamera.ScreenPointToRay(Mouse.current.position.ReadValue());
        CityDistrict hoveredNow = null;

        // Raycast against the ground plane
        Plane groundPlane = new Plane(Vector3.up, Vector3.zero);
        if (groundPlane.Raycast(ray, out float distance)) {
            Vector3 hitPoint = ray.origin + ray.direction * distance;
            hoveredNow = generator.GetDistrictAtWorldPos(hitPoint);
        }

        // Update visuals if hover changed
        if (hoveredNow != hoveredDistrict) {
            if (hoveredDistrict != null && hoveredDistrict != selectedDistrict) {
                generator.ClearHighlight(hoveredDistrict.Id);
            }

            hoveredDistrict = hoveredNow;

            if (hoveredDistrict != null && hoveredDistrict != selectedDistrict) {
                generator.HighlightDistrict(hoveredDistrict.Id);
            }
        }
    }

    private void HandleDistrictSelection() {
        var ray = mainCamera.ScreenPointToRay(Mouse.current.position.ReadValue());

        // Raycast against the ground plane
        Plane groundPlane = new Plane(Vector3.up, Vector3.zero);
        if (groundPlane.Raycast(ray, out float distance)) {
            Vector3 hitPoint = ray.origin + ray.direction * distance;
            var hitDistrict = generator.GetDistrictAtWorldPos(hitPoint);

            if (hitDistrict != null) {
                if (selectedDistrict == hitDistrict) {
                    // Deselect
                    DeselectDistrict();
                } else {
                    // Select new district
                    if (selectedDistrict != null) {
                        generator.ClearHighlight(selectedDistrict.Id);
                    }

                    selectedDistrict = hitDistrict;
                    generator.HighlightDistrict(selectedDistrict.Id);
                    Debug.Log($"[CityDistrictSelectionController] Selected district {selectedDistrict.Id}");

                    // Notify UI
                    if (districtPanel != null) {
                        districtPanel.OnDistrictSelected();
                    }
                }
            }
        }
    }

    private void ClearDistrictSelection() {
        if (selectedDistrict != null) {
            generator.ClearHighlight(selectedDistrict.Id);
        }
        selectedDistrict = null;
    }
}

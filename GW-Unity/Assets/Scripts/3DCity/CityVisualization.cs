using UnityEngine;
using UnityEngine.InputSystem;

/// <summary>
/// Main controller for 3D city camera and interaction.
/// Handles camera orbiting, zooming, panning around the city grid.
/// </summary>
public class CityVisualization : MonoBehaviour {
    // Camera movement variables
    private DistrictVisual selectedDistrict; // Currently selected district, if any

    Camera mainCamera;

    private CityRaycaster raycaster; // For raycasting to select districts and terrain features

    private void Start() {
        if (mainCamera == null)
            mainCamera = Camera.main;

        raycaster = GetComponent<CityRaycaster>();
        if (raycaster == null)
            raycaster = gameObject.AddComponent<CityRaycaster>();

    }

    private void Update() {
        HandleRaycasting();
    }




    private void HandleRaycasting() {
        var mouse = Mouse.current;
        if (mouse == null) return;

        if (mouse.leftButton.wasPressedThisFrame) {
            // Left click - select district
            var hitDistrict = raycaster.GetDistrictAtMousePosition();
            if (hitDistrict != null) {
                SelectDistrict(hitDistrict);
            }
        }
    }
    public void SelectDistrict(DistrictVisual district) {
        if (selectedDistrict != null)
            selectedDistrict.Deselect();

        selectedDistrict = district;
        selectedDistrict.Select();

        EventSystem.Instance?.Fire(GameEvents.UI_SELECT_DISTRICT, selectedDistrict.GetDistrictId());
    }


}

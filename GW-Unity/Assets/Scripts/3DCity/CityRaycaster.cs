using UnityEngine;
using UnityEngine.InputSystem;

/// <summary>
/// Detects building/district clicks and fires selection events.
/// Uses raycasting from camera through mouse position.
/// </summary>
public class CityRaycaster : MonoBehaviour
{
    private Camera mainCamera;
    private LayerMask districtLayerMask;

    private void Start()
    {
        mainCamera = Camera.main;
        districtLayerMask = LayerMask.GetMask("Buildings", "Districts");
    }

    public DistrictVisual GetDistrictAtMousePosition()
    {
        var mouse = Mouse.current;
        if (mouse == null) return null;

        Ray ray = mainCamera.ScreenPointToRay(mouse.position.ReadValue());
        return GetDistrictFromRay(ray);
    }

    public DistrictVisual GetDistrictFromRay(Ray ray)
    {
        if (Physics.Raycast(ray, out RaycastHit hit, 1000f))
        {
            var districtVisual = hit.collider.GetComponent<DistrictVisual>();
            if (districtVisual != null)
            {
                Debug.Log($"Hit district: {districtVisual.GetDistrictData().Name}");
                return districtVisual;
            }
        }
        return null;
    }

    public District GetDistrictDataAtMousePosition()
    {
        var visual = GetDistrictAtMousePosition();
        return visual != null ? visual.GetDistrictData() : null;
    }
}

using UnityEngine;

/// <summary>
/// Main controller for 3D city camera and interaction.
/// Handles camera orbiting, zooming, panning around the city grid.
/// </summary>
public class CityVisualization : MonoBehaviour
{
    [SerializeField] private Camera mainCamera;
    [SerializeField] private float orbitSpeed = 2f;
    [SerializeField] private float zoomSpeed = 5f;
    [SerializeField] private float minZoom = 5f;
    [SerializeField] private float maxZoom = 50f;
    [SerializeField] private Vector3 orbitCenter = Vector3.zero;

    private float currentZoom = 15f;
    private float orbitAngle = 45f;
    private float verticalAngle = 30f;

    private CityRaycaster raycaster;
    private DistrictVisual selectedDistrict;

    private void Start()
    {
        if (mainCamera == null)
            mainCamera = Camera.main;

        raycaster = GetComponent<CityRaycaster>();
        if (raycaster == null)
            raycaster = gameObject.AddComponent<CityRaycaster>();

        UpdateCameraPosition();
    }

    private void Update()
    {
        HandleInput();
        UpdateCameraPosition();
        HandleRaycasting();
    }

    private void HandleInput()
    {
        // Orbit with Arrow Keys or A/D
        if (Input.GetKey(KeyCode.A) || Input.GetKey(KeyCode.LeftArrow))
            orbitAngle -= orbitSpeed * Time.deltaTime * 50f;

        if (Input.GetKey(KeyCode.D) || Input.GetKey(KeyCode.RightArrow))
            orbitAngle += orbitSpeed * Time.deltaTime * 50f;

        // Zoom with Mouse Scroll or Q/E
        if (Input.GetKey(KeyCode.Q))
            currentZoom += zoomSpeed * Time.deltaTime;

        if (Input.GetKey(KeyCode.E))
            currentZoom -= zoomSpeed * Time.deltaTime;

        currentZoom = Mathf.Clamp(currentZoom, minZoom, maxZoom);

        // Mouse wheel zoom
        float scroll = Input.GetAxis("Mouse ScrollWheel");
        if (scroll != 0)
        {
            currentZoom -= scroll * zoomSpeed * Time.deltaTime * 50f;
            currentZoom = Mathf.Clamp(currentZoom, minZoom, maxZoom);
        }

        // Pan with right mouse drag
        if (Input.GetMouseButton(1))
        {
            float deltaX = Input.GetAxis("Mouse X");
            float deltaY = Input.GetAxis("Mouse Y");
            orbitCenter += new Vector3(-deltaX * 0.5f, 0, -deltaY * 0.5f);
        }
    }

    private void UpdateCameraPosition()
    {
        // Calculate camera position in spherical coordinates around orbit center
        float radians = orbitAngle * Mathf.Deg2Rad;
        float verticalRadians = verticalAngle * Mathf.Deg2Rad;

        float horizontalDist = currentZoom * Mathf.Cos(verticalRadians);
        float verticalDist = currentZoom * Mathf.Sin(verticalRadians);

        Vector3 cameraPosition = orbitCenter + new Vector3(
            horizontalDist * Mathf.Sin(radians),
            verticalDist,
            horizontalDist * Mathf.Cos(radians)
        );

        mainCamera.transform.position = cameraPosition;
        mainCamera.transform.LookAt(orbitCenter + Vector3.up * 2f);
    }

    private void HandleRaycasting()
    {
        if (Input.GetMouseButtonDown(0))
        {
            // Left click - select district
            var hitDistrict = raycaster.GetDistrictAtMousePosition();
            if (hitDistrict != null)
            {
                SelectDistrict(hitDistrict);
            }
        }
    }

    public void SelectDistrict(DistrictVisual district)
    {
        if (selectedDistrict != null)
            selectedDistrict.Deselect();

        selectedDistrict = district;
        selectedDistrict.Select();

        EventSystem.Instance?.Fire(GameEvents.UI_SELECT_DISTRICT, selectedDistrict.GetDistrictId());
    }

    public DistrictVisual GetSelectedDistrict()
    {
        return selectedDistrict;
    }

    public void SetOrbitCenter(Vector3 newCenter)
    {
        orbitCenter = newCenter;
    }

    public Vector3 GetOrbitCenter()
    {
        return orbitCenter;
    }
}

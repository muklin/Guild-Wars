using System;
using UnityEngine;


public class CameraController : MonoBehaviour {
    public static CameraController instance;

    [Header("Movement Settings")]
    [SerializeField, Range(0f, 0.25f)]
    private float moveSmoothing = 0.075f;
    [SerializeField] private float moveSpeed = 30f;
    [SerializeField] private float screenPanBorderThickness = 12.5f;
    [SerializeField] private bool movementByMouse = false;

    private Vector3 desiredCameraPosition;
    private float horizontal;
    private float vertical;

    [Header("Rotation Settings")]
    [SerializeField, Range(0f, 0.25f)]
    private float rotationSmoothing = 0.05f;
    [SerializeField] private float rotationSpeed = 30f;
    [SerializeField] private float snapDegreeValue = 90f;
    [SerializeField] private bool snapRotation = true;

    private Quaternion desiredCameraRotation;

    [Header("Zoom Settings")]
    [SerializeField] private float scrollSensitivity = 250f;

    [Header("Bounding Settings")]
    [SerializeField] private float minHeightFromGround = 5f;
    [SerializeField] private float maxHeightFromGround = 45f;
    
    private Terrain terrainToHoverOver;
    private float minHeight, maxHeight;

    [Header("Other Settings")]
    [SerializeField, Range(30f, 90f)] private float camXRotation = 30f;

    [SerializeField, Range(45f, 75f)] private float camFieldOfView = 60f;
    private float zoom = 1f;
    [SerializeField] private bool lockMouseCursor = true;

    private void Awake() {
        if (instance == null)
            instance = this;
        else
            Debug.LogError("Another Camera Controller already active.");

        desiredCameraPosition = transform.position;
        desiredCameraRotation = transform.rotation;

        //terrainToHoverOver = GameManager.instance.mainTerrain;
        //terrainPosition = terrainToHoverOver.transform.position;
        //terrainSize = terrainToHoverOver.terrainData.size;

        AdjustFieldOfView(camFieldOfView);
        AdjustXRotation(camXRotation, true);
        //ToggleSnapRotation(snapRotation, true);

        if (lockMouseCursor)
            Cursor.lockState = CursorLockMode.Confined;
    }

    private void Update() {
        CheckMovement();
        CheckZoom();
        CheckRotation();
    }

    private void LateUpdate() {
        MoveCamera();
        CheckBounds();
    }

    private void CheckMovement() {
        horizontal = Input.GetAxis("Horizontal");
        vertical = Input.GetAxis("Vertical");

        if (movementByMouse)
            CheckMovementFromMouse();

        if (horizontal == 0f && vertical == 0f)
            return;

        // Adjust movement speed based on zoom level
        float adjustedMoveSpeed = 1/zoom;

        Quaternion facingRotation = Quaternion.Euler(0f, desiredCameraRotation.eulerAngles.y, 0f);
        desiredCameraPosition += facingRotation * Vector3.right * horizontal * adjustedMoveSpeed * moveSpeed * Time.deltaTime;
        desiredCameraPosition += facingRotation * Vector3.forward * vertical * adjustedMoveSpeed * moveSpeed * Time.deltaTime;
    }
    
    private void CheckZoom() {
        float scrollValue = Input.mouseScrollDelta.y;
        if (scrollValue == 0f)
            return;

        // move the camera along its forward vector
        if (scrollValue < 0f)
            scrollValue = -1f; // Zoom out
        else if (scrollValue > 0f)
            scrollValue = 1f; // Zoom in
        float zoomAmount = scrollValue * scrollSensitivity * Time.deltaTime;


        if (zoom+zoomAmount < 1 || zoom+zoomAmount > 30) {
            if (zoom + zoomAmount < 1) {
                zoomAmount = -zoom;
                zoom = 1;
            }
            else { 
                zoomAmount = zoom;
                zoom = 30;
            }
        } else { 
            zoom += zoomAmount;
        }
        
        // depending on campera projection, either move the camera or the size
        if (Camera.main.orthographic) {
            Camera.main.orthographicSize -= zoomAmount;
        }
        else {
            desiredCameraPosition += transform.forward * zoomAmount;
        }
    }

    private void CheckRotation() {
        float rotationAngle = 0;
        if (snapRotation) {
            if (Input.GetKeyDown(KeyCode.E))
                rotationAngle = snapDegreeValue;

            if (Input.GetKeyDown(KeyCode.Q))
                rotationAngle = -snapDegreeValue;
        }
        else {
            if (Input.GetKey(KeyCode.E))
                rotationAngle = rotationSpeed * Time.deltaTime;

            if (Input.GetKey(KeyCode.Q))
                rotationAngle = -rotationSpeed * Time.deltaTime;
        }

        if (rotationAngle == 0)
            return;

        Vector3 screenCenter = GetScreenCenterPoint(); // Get current screen center point
        Quaternion desiredRotation = Quaternion.AngleAxis(rotationAngle, Vector3.up); // Get the desired rotation
        Vector3 directionDifference = desiredCameraPosition - screenCenter; // Find current direction relative to center
        directionDifference = desiredRotation * directionDifference; // Rotate the direction vector

        //desiredCameraPosition = screenCenter + directionDifference; // Update camera to new position
        desiredCameraRotation = desiredRotation * desiredCameraRotation; // Rotate camera to keep looking at the center
    }

    private void MoveCamera() {
        if (transform.position != desiredCameraPosition)
            transform.position = Vector3.Lerp(transform.position, desiredCameraPosition, moveSmoothing);

        if (transform.rotation != desiredCameraRotation)
            transform.rotation = Quaternion.Lerp(transform.rotation, desiredCameraRotation, rotationSmoothing);
    }

    private void CheckBounds() {
        //float currentTerrainHeight = terrainToHoverOver.SampleHeight(transform.position);
        minHeight = 10f;
        maxHeight = 20f;
        //minHeight = currentTerrainHeight + minHeightFromGround;
        //maxHeight = currentTerrainHeight + maxHeightFromGround;

        //desiredCameraPosition.y = Mathf.Clamp(desiredCameraPosition.y, minHeight, maxHeight);

        //desiredCameraPosition.x = Mathf.Clamp(desiredCameraPosition.x, terrainPosition.x, terrainPosition.x + terrainSize.x);
        //desiredCameraPosition.z = Mathf.Clamp(desiredCameraPosition.z, terrainPosition.z, terrainPosition.z + terrainSize.z);
    }

    private void CheckMovementFromMouse() {

        Vector3 currentMousePosition = Input.mousePosition;

        if (currentMousePosition.x <= screenPanBorderThickness)
            horizontal = -1;
        if (currentMousePosition.x >= Screen.width - screenPanBorderThickness)
            horizontal = 1;
        if (currentMousePosition.y <= screenPanBorderThickness)
            vertical = -1;
        if (currentMousePosition.y >= Screen.height - screenPanBorderThickness)
            vertical = 1;
    }

    private Vector3 GetScreenCenterPoint() {
        Vector3 screenCenterPoint = Vector3.zero;
        Ray screenCenterRay = Camera.main.ScreenPointToRay(new Vector2(Screen.width / 2, Screen.height / 2));
        if (Physics.Raycast(screenCenterRay, out RaycastHit hitPoint, 1000f))
            screenCenterPoint = hitPoint.point;
        //else
        //Debug.LogError("Screen center raycast not hitting anything");
        //Debug.LogWarning("Screen center raycast not hitting anything");
        return screenCenterPoint;
    }

    public void AdjustFieldOfView(float valueFOV) {
        camFieldOfView = valueFOV;
        Camera.main.fieldOfView = camFieldOfView;
    }

    public void AdjustXRotation(float valueXRotation, bool instant = false) {
        camXRotation = valueXRotation;
        desiredCameraRotation = Quaternion.Euler(camXRotation, desiredCameraRotation.eulerAngles.y, desiredCameraRotation.eulerAngles.z);

        if (instant)
            transform.rotation = desiredCameraRotation;
    }

    public void ToggleSnapRotation(bool snapRotationActive, bool instant = false) {
        if (snapRotationActive && desiredCameraRotation.eulerAngles.y % snapDegreeValue != 0)
            desiredCameraRotation = Quaternion.Euler(desiredCameraRotation.eulerAngles.x, 0f, desiredCameraRotation.eulerAngles.z);

        snapRotation = snapRotationActive;

        if (instant)
            transform.rotation = desiredCameraRotation;
    }

    public void ToggleMovementByMouse(bool movementByMouseActive) {
        movementByMouse = movementByMouseActive;
    }

    public void MoveCameraToPosition(float x, float z, bool zoomOutOnMove = false, float y = 0) {
        Vector3 screenCenterPoint = GetScreenCenterPoint(); // Get current screen center point
        Vector3 centerDifferenceVector = transform.position - screenCenterPoint; // Find current center-to-camera vector

        desiredCameraPosition.x = x;
        desiredCameraPosition.z = z;
        if (zoomOutOnMove)
            desiredCameraPosition.y = maxHeight;
        else if (y > 0)
            desiredCameraPosition.y = y;

        desiredCameraPosition.x += centerDifferenceVector.x;
        desiredCameraPosition.z += centerDifferenceVector.z;
    }


    public Vector3 GetCurrentDesiredCameraPosition() {
        return desiredCameraPosition;
    }
}

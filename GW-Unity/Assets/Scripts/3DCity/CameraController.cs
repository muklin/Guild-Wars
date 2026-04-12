using UnityEngine;
using UnityEngine.InputSystem;

/// <summary>
/// Main controller for 3D city camera and interaction.
/// Handles camera orbiting, zooming, panning around the city grid.
/// </summary>

public class CameraController : MonoBehaviour {

    [SerializeField] private Camera thisCamera;
    private float horizontal; // Input axis values for movement
    private float vertical; // Input axis values for movement

    [Header("Movement Settings")]
    [SerializeField, Range(0f, 0.25f)]
    private float moveSmoothing = 0.075f; // Higher = slower camera movement (more smoothing)
    [SerializeField] private float moveSpeed = 30f; // Base movement speed; actual speed is adjusted based on zoom level for consistent feel
    [SerializeField] private float zoomSpeed = 1f; // Higher = faster zooming; also affects movement speed for consistent feel (see moveSpeed)

    private Vector3 desiredCameraPosition; // The target position the camera moves towards smoothly

    [Header("Rotation Settings")]
    [SerializeField] private float rotationSpeed = 30f;
    [SerializeField] private bool snapRotation = true; // Prevents free rotation, only allows 90° snaps


    private Quaternion desiredCameraRotation;
    private float zoomOrthographicSize = 10f;

    [SerializeField, Range(45f, 75f)] private float camFieldOfView = 60f;

    private Vector3 startLocation = new Vector3(-15f, 35f, -15f);
    private Quaternion startRotation = Quaternion.Euler(30f, 45f, 0f);

    private void Start() {
        if (thisCamera == null)
            thisCamera = GetComponent<Camera>();
        thisCamera.tag = "MainCamera";
        thisCamera.clearFlags = CameraClearFlags.SolidColor;
        thisCamera.backgroundColor = new Color(0.1f, 0.1f, 0.1f, 1f);

        // Isometric orthographic setup
        thisCamera.orthographic = true;
        thisCamera.orthographicSize = 10f;
        thisCamera.nearClipPlane = 0.3f;
        thisCamera.farClipPlane = 1000f;

        // Initialize camera position and rotation
        desiredCameraPosition = startLocation;
        desiredCameraRotation = startRotation;
        UpdateCameraPosition();
    }

    private void Update() {
        CheckMovement();
        CheckZoom();
        CheckRotation();
    }

    private void LateUpdate() {
        MoveCamera();
    }

    private void CheckMovement() {
        var keyboard = Keyboard.current;
        if (keyboard == null)
            return;

        horizontal = 0f;
        vertical = 0f;

        if (keyboard[Key.W].isPressed || keyboard[Key.UpArrow].isPressed)
            vertical += 1f;
        if (keyboard[Key.S].isPressed || keyboard[Key.DownArrow].isPressed)
            vertical -= 1f;
        if (keyboard[Key.A].isPressed || keyboard[Key.LeftArrow].isPressed)
            horizontal -= 1f;
        if (keyboard[Key.D].isPressed || keyboard[Key.RightArrow].isPressed)
            horizontal += 1f;

        if (horizontal == 0f && vertical == 0f)
            return;

        // Adjust movement speed based on zoomSpeed level
        float adjustedMoveSpeed = 1 / zoomSpeed;

        Quaternion facingRotation = Quaternion.Euler(0f, desiredCameraRotation.eulerAngles.y, 0f);
        desiredCameraPosition += facingRotation * Vector3.right * horizontal * adjustedMoveSpeed * moveSpeed * Time.deltaTime;
        desiredCameraPosition += facingRotation * Vector3.forward * vertical * adjustedMoveSpeed * moveSpeed * Time.deltaTime;
    }

    private void CheckZoom() {
        var mouse = Mouse.current;
        if (mouse == null)
            return;

        float scrollValue = mouse.scroll.ReadValue().y;
        if (scrollValue == 0f)
            return;

        // Normalize scroll to -1 or +1
        scrollValue = scrollValue < 0f ? -1f : 1f; // zoom out: -1, zoom in: +1

        // adjust orthographicSize (larger = more zoomed out)
        float zoomDelta = -scrollValue * 2f; // Negative because larger size = zoom out
        zoomOrthographicSize = Mathf.Clamp(zoomOrthographicSize + zoomDelta, 1f, 10f);

    }

    private void CheckRotation() {
        var keyboard = Keyboard.current;
        if (keyboard == null)
            return;

        float snapDegreeValue = 90f;
        float rotationAngle = 0;

        if (snapRotation) {
            if (keyboard[Key.E].wasPressedThisFrame)
                rotationAngle = snapDegreeValue;

            if (keyboard[Key.Q].wasPressedThisFrame)
                rotationAngle = -snapDegreeValue;
        } else {
            if (keyboard[Key.E].isPressed)
                rotationAngle = rotationSpeed * Time.deltaTime;

            if (keyboard[Key.Q].isPressed)
                rotationAngle = -rotationSpeed * Time.deltaTime;
        }

        if (rotationAngle == 0)
            return;

        RotateBy(rotationAngle);
    }

    private void RotateBy(float angleAroundY) {
        try {
            Vector3 screenCenter = GetScreenCenterPoint();
            Quaternion desiredRotation = Quaternion.AngleAxis(angleAroundY, Vector3.up);
            Vector3 directionFromOrbit = desiredCameraPosition - screenCenter;
            directionFromOrbit = desiredRotation * directionFromOrbit;
            desiredCameraPosition = screenCenter + directionFromOrbit;
            desiredCameraRotation = desiredRotation * desiredCameraRotation;
        } catch (System.Exception e) {
            Debug.LogError($"Error in RotateBy: {e.Message}");
            return;
        }

    }

    private void MoveCamera() {
        Vector3 screenCenter = GetScreenCenterPoint();

        if (transform.position != desiredCameraPosition)
            transform.position = Vector3.Lerp(transform.position, desiredCameraPosition, moveSmoothing);

        if (transform.rotation != desiredCameraRotation)
            transform.rotation = Quaternion.Lerp(transform.rotation, desiredCameraRotation, moveSmoothing);

        if (thisCamera.orthographicSize != zoomOrthographicSize)
            //thisCamera.orthographicSize = zoomOrthographicSize; 
            Mathf.Lerp(thisCamera.orthographicSize, zoomOrthographicSize, moveSmoothing);
    }

    private Vector3 GetScreenCenterPoint() {
        Vector3 screenCenterPoint = Vector3.zero;
        Ray screenCenterRay = thisCamera.ScreenPointToRay(new Vector2(Screen.width / 2, Screen.height / 2));
        if (Physics.Raycast(screenCenterRay, out RaycastHit hitPoint, 1000f))
            screenCenterPoint = hitPoint.point;
        else {
            Debug.LogError("Screen center raycast not hitting anything");
            //Debug.LogWarning("Screen center raycast not hitting anything");
        }
        return screenCenterPoint;
    }


    private void UpdateCameraPosition() {
        thisCamera.fieldOfView = camFieldOfView;
        if (transform.position == desiredCameraPosition && transform.rotation == desiredCameraRotation)
            return;

        transform.position = desiredCameraPosition;
        transform.rotation = desiredCameraRotation;

    }

}

using UnityEngine;
using UnityEngine.UI;
using UnityEngine.EventSystems;
using UnityEngine.InputSystem;
using UnityEngine.InputSystem.UI;
using System.Collections.Generic;


/// <summary>
/// UI panel for terrain setup. Displays terrain type buttons and description input.
/// Shows during Setup Phase terrain step only.
/// </summary>
public class TerrainTypePanel : MonoBehaviour {
    private TerrainSelectionController regionController;
    private EdgeSelectionController edgeController;
    private SetupPhase SetupPhase;
    private CanvasGroup canvasGroup;

    // UI Elements
    private InputField descriptionInput;
    private Text statusText;
    private Button doneButton;
    private Button applyButton;
    private Dictionary<TerrainType, Button> typeButtons = new();
    private Dictionary<EdgeFeature.EdgeFeatureType, Button> edgeFeatureButtons = new();
    private TerrainType selectedTerrainType = TerrainType.Plains; // Track selected type
    private EdgeFeature.EdgeFeatureType selectedEdgeFeatureType = EdgeFeature.EdgeFeatureType.Cliff; // Track selected edge type

    // Panel modes
    private enum PanelMode { Region, Edge }
    private PanelMode currentMode = PanelMode.Region;

    // Track what's selected for mode switching
    private bool regionSelected = false;
    private bool edgeSelected = false;

    public void Initialize(TerrainSelectionController regionController, EdgeSelectionController edgeController, SetupPhase SetupPhase) {
        Debug.Log("[TerrainTypePanel] Initialize() called");
        this.regionController = regionController;
        this.edgeController = edgeController;
        this.SetupPhase = SetupPhase;

        Debug.Log("[TerrainTypePanel] About to call SetupPanelLayout()");
        SetupPanelLayout();
        Debug.Log("[TerrainTypePanel] SetupPanelLayout() returned");
        SetupEventSubscriptions();
        Debug.Log("[TerrainTypePanel] Event subscriptions set up");

        // Hidden by default, shown when Setup Phase starts
        canvasGroup.alpha = 0f;
        canvasGroup.blocksRaycasts = false;
    }

    private void Update() {
        // Handle button clicks and hover detection using RectTransformUtility
        if (!gameObject.activeInHierarchy || canvasGroup.alpha == 0f)
            return;

        var mouse = Mouse.current;
        if (mouse == null)
            return;

        var mousePos = mouse.position.ReadValue();
        var canvas = GetComponentInParent<Canvas>();
        if (canvas == null)
            return;

        // Disable camera input when description field has focus
        if (descriptionInput != null) {
            if (descriptionInput.isFocused) {
                CameraController.IsInputEnabled = false;
            } else {
                CameraController.IsInputEnabled = true;
            }
        }

        // Check hover on panel and elements
        UpdateHoverEffects(mousePos, canvas);

        if (!mouse.leftButton.wasPressedThisFrame)
            return;

        // Check if click is within the panel rect
        var panelRect = GetComponent<RectTransform>();
        if (RectTransformUtility.RectangleContainsScreenPoint(panelRect, mousePos, canvas.worldCamera)) {
            Debug.Log($"[TerrainTypePanel] Click inside panel bounds");

            // Check if click is within the description input field
            if (descriptionInput != null) {
                var descRect = descriptionInput.GetComponent<RectTransform>();
                if (RectTransformUtility.RectangleContainsScreenPoint(descRect, mousePos, canvas.worldCamera)) {
                    Debug.Log($"[TerrainTypePanel] Click inside description input — activating");
                    descriptionInput.ActivateInputField();
                    return;
                }
            }

            // Check if click is within the Apply button
            if (applyButton != null && applyButton.gameObject.activeInHierarchy) {
                var applyRect = applyButton.GetComponent<RectTransform>();
                if (RectTransformUtility.RectangleContainsScreenPoint(applyRect, mousePos, canvas.worldCamera)) {
                    Debug.Log($"[TerrainTypePanel] *** CLICK HIT APPLY BUTTON ***");
                    applyButton.onClick.Invoke();
                    return;
                }
            }

            // Check if click is within the Done button
            if (doneButton != null && doneButton.gameObject.activeInHierarchy) {
                var doneRect = doneButton.GetComponent<RectTransform>();
                if (RectTransformUtility.RectangleContainsScreenPoint(doneRect, mousePos, canvas.worldCamera)) {
                    Debug.Log($"[TerrainTypePanel] *** CLICK HIT DONE BUTTON ***");
                    doneButton.onClick.Invoke();
                    return;
                }
            }

            // Check if click is within any terrain type button's rect
            foreach (var kvp in typeButtons) {
                var button = kvp.Value;
                if (!button.gameObject.activeInHierarchy)
                    continue;

                var buttonRect = button.GetComponent<RectTransform>();
                if (RectTransformUtility.RectangleContainsScreenPoint(buttonRect, mousePos, canvas.worldCamera)) {
                    Debug.Log($"[TerrainTypePanel] *** CLICK HIT BUTTON {kvp.Key} ***");
                    button.onClick.Invoke();
                    return;
                }
            }

            // Check if click is within any edge feature button's rect
            foreach (var kvp in edgeFeatureButtons) {
                var button = kvp.Value;
                if (!button.gameObject.activeInHierarchy)
                    continue;

                var buttonRect = button.GetComponent<RectTransform>();
                if (RectTransformUtility.RectangleContainsScreenPoint(buttonRect, mousePos, canvas.worldCamera)) {
                    Debug.Log($"[TerrainTypePanel] *** CLICK HIT EDGE BUTTON {kvp.Key} ***");
                    button.onClick.Invoke();
                    return;
                }
            }
        }
    }

    private void UpdateHoverEffects(Vector2 mousePos, Canvas canvas) {
        // Check panel hover
        var panelRect = GetComponent<RectTransform>();
        var panelImage = GetComponent<Image>();
        bool panelHovered = RectTransformUtility.RectangleContainsScreenPoint(panelRect, mousePos, canvas.worldCamera);

        if (panelImage != null) {
            Color targetColor = panelHovered ? Color.Lerp(new Color(0.1f, 0.1f, 0.1f, 0.9f), Color.white, 0.2f) : new Color(0.1f, 0.1f, 0.1f, 0.9f);
            panelImage.color = targetColor;
        }

        // Check Apply button hover
        if (applyButton != null && applyButton.gameObject.activeInHierarchy) {
            var applyRect = applyButton.GetComponent<RectTransform>();
            var applyImage = applyButton.GetComponent<Image>();
            bool applyHovered = RectTransformUtility.RectangleContainsScreenPoint(applyRect, mousePos, canvas.worldCamera);

            if (applyImage != null) {
                Color baseColor = new Color(0.2f, 0.4f, 0.6f);
                Color targetColor = applyHovered ? Color.Lerp(baseColor, Color.white, 0.3f) : baseColor;
                applyImage.color = targetColor;
            }
        }

        // Check terrain type button hovers
        foreach (var kvp in typeButtons) {
            var button = kvp.Value;
            if (!button.gameObject.activeInHierarchy)
                continue;

            var buttonRect = button.GetComponent<RectTransform>();
            var buttonImage = button.GetComponent<Image>();
            bool buttonHovered = RectTransformUtility.RectangleContainsScreenPoint(buttonRect, mousePos, canvas.worldCamera);

            if (buttonImage != null) {
                Color baseColor = TerrainColors.For(kvp.Key);
                Color targetColor = buttonHovered ? Color.Lerp(baseColor, Color.white, 0.3f) : baseColor;
                buttonImage.color = targetColor;
            }
        }

        // Check edge feature button hovers
        foreach (var kvp in edgeFeatureButtons) {
            var button = kvp.Value;
            if (!button.gameObject.activeInHierarchy)
                continue;

            var buttonRect = button.GetComponent<RectTransform>();
            var buttonImage = button.GetComponent<Image>();
            bool buttonHovered = RectTransformUtility.RectangleContainsScreenPoint(buttonRect, mousePos, canvas.worldCamera);

            if (buttonImage != null) {
                var terrainTypeForEdge = kvp.Key == EdgeFeature.EdgeFeatureType.Cliff ? TerrainType.Cliffs : TerrainType.River;
                Color baseColor = TerrainColors.For(terrainTypeForEdge);
                Color targetColor = buttonHovered ? Color.Lerp(baseColor, Color.white, 0.3f) : baseColor;
                buttonImage.color = targetColor;
            }
        }

        // Check Done button hover
        if (doneButton != null && doneButton.gameObject.activeInHierarchy) {
            var doneRect = doneButton.GetComponent<RectTransform>();
            var doneImage = doneButton.GetComponent<Image>();
            bool doneHovered = RectTransformUtility.RectangleContainsScreenPoint(doneRect, mousePos, canvas.worldCamera);

            if (doneImage != null) {
                Color baseColor = new Color(0.2f, 0.5f, 0.2f);
                Color targetColor = doneHovered ? Color.Lerp(baseColor, Color.white, 0.3f) : baseColor;
                doneImage.color = targetColor;
            }
        }

        // Check description input hover
        if (descriptionInput != null) {
            var descRect = descriptionInput.GetComponent<RectTransform>();
            var descBg = descriptionInput.GetComponent<Image>();
            bool descHovered = RectTransformUtility.RectangleContainsScreenPoint(descRect, mousePos, canvas.worldCamera);

            if (descBg != null) {
                Color targetColor = descHovered ? Color.Lerp(new Color(0.2f, 0.2f, 0.2f, 1f), Color.white, 0.2f) : new Color(0.2f, 0.2f, 0.2f, 1f);
                descBg.color = targetColor;
            }
        }
    }

    private void SetupPanelLayout() {
        Debug.Log("[TerrainTypePanel] SetupPanelLayout() START");

        // Ensure Canvas has a GraphicRaycaster for UI input
        var canvas = GetComponentInParent<Canvas>();
        if (canvas != null && canvas.GetComponent<GraphicRaycaster>() == null) {
            Debug.Log("[TerrainTypePanel] Adding GraphicRaycaster to Canvas");
            canvas.gameObject.AddComponent<GraphicRaycaster>();
        }

        // Ensure EventSystem exists with correct input module
        var existingEventSystem = FindAnyObjectByType<EventSystem>();

        if (existingEventSystem == null) {
            Debug.Log("[TerrainTypePanel] No EventSystem found, creating one...");
            var eventSystemGO = new GameObject("EventSystem");
            existingEventSystem = eventSystemGO.AddComponent<EventSystem>();
        }

        // Ensure it has InputSystemUIInputModule
        if (existingEventSystem.GetComponent<InputSystemUIInputModule>() == null) {
            Debug.Log("[TerrainTypePanel] Adding InputSystemUIInputModule to EventSystem");
            existingEventSystem.gameObject.AddComponent<InputSystemUIInputModule>();
        }

        var rectTransform = GetComponent<RectTransform>();
        rectTransform.anchorMin = new Vector2(0, 0);
        rectTransform.anchorMax = new Vector2(0, 1);
        rectTransform.offsetMin = Vector2.zero;
        rectTransform.offsetMax = new Vector2(200, 0);

        // Panel background - add as Button so it blocks raycasts and absorbs clicks
        var bgImage = gameObject.AddComponent<Image>();
        bgImage.color = new Color(0.1f, 0.1f, 0.1f, 0.9f);
        bgImage.raycastTarget = true;

        // Add Button component to panel background so it blocks all clicks within its bounds
        var bgButton = gameObject.AddComponent<Button>();
        bgButton.interactable = true;
        // Add a no-op listener so button is properly registered with EventSystem
        bgButton.onClick.AddListener(() => {
            Debug.Log("[TerrainTypePanel] Panel background clicked (should not propagate to buttons)");
        });
        Debug.Log("[TerrainTypePanel] Panel background Button added to block raycasts");

        canvasGroup = gameObject.AddComponent<CanvasGroup>();

        // Vertical layout
        var layoutGroup = gameObject.AddComponent<VerticalLayoutGroup>();
        layoutGroup.padding = new RectOffset(10, 10, 10, 10);
        layoutGroup.spacing = 5f;
        layoutGroup.childForceExpandHeight = false;
        layoutGroup.childForceExpandWidth = true;

        // Header
        var headerGO = new GameObject("Header");
        headerGO.transform.SetParent(transform);
        var headerText = headerGO.AddComponent<Text>();
        headerText.font = Resources.GetBuiltinResource<Font>("LegacyRuntime.ttf");
        headerText.text = "Terrain Setup";
        headerText.font.RequestCharactersInTexture(headerText.text);
        headerText.color = Color.white;
        headerText.fontSize = 16;
        headerText.fontStyle = FontStyle.Bold;
        headerText.alignment = TextAnchor.MiddleCenter;
        var headerLayout = headerGO.AddComponent<LayoutElement>();
        headerLayout.preferredHeight = 30;

        // Terrain type buttons
        var typeButtonsGO = new GameObject("TypeButtons");
        typeButtonsGO.transform.SetParent(transform);
        var typeLayout = typeButtonsGO.AddComponent<VerticalLayoutGroup>();
        typeLayout.spacing = 2f;
        typeLayout.childForceExpandHeight = false;
        typeLayout.childForceExpandWidth = true;

        foreach (TerrainType type in System.Enum.GetValues(typeof(TerrainType))) {
            var buttonGO = new GameObject(type.ToString());
            buttonGO.transform.SetParent(typeButtonsGO.transform, false);

            var buttonRect = buttonGO.GetComponent<RectTransform>();
            if (buttonRect == null)
                buttonRect = buttonGO.AddComponent<RectTransform>();

            var buttonImage = buttonGO.AddComponent<Image>();
            buttonImage.color = TerrainColors.For(type);
            buttonImage.raycastTarget = true;

            var buttonComponent = buttonGO.AddComponent<Button>();
            buttonComponent.interactable = true;
            var colors = buttonComponent.colors;
            var baseColor = TerrainColors.For(type);
            colors.normalColor = baseColor;
            colors.highlightedColor = Color.Lerp(baseColor, Color.white, 0.5f); // Lighter version for hover
            colors.pressedColor = new Color(0.2f, 1f, 1f, 1f); // Bright cyan for selected
            colors.disabledColor = new Color(0.5f, 0.5f, 0.5f);
            buttonComponent.colors = colors;

            var buttonText = new GameObject("Text");
            buttonText.transform.SetParent(buttonGO.transform, false);
            var buttonTextRect = buttonText.GetComponent<RectTransform>();
            if (buttonTextRect == null)
                buttonTextRect = buttonText.AddComponent<RectTransform>();
            // Fill parent button to display text
            buttonTextRect.anchorMin = Vector2.zero;
            buttonTextRect.anchorMax = Vector2.one;
            buttonTextRect.offsetMin = Vector2.zero;
            buttonTextRect.offsetMax = Vector2.zero;

            var textComponent = buttonText.AddComponent<Text>();
            textComponent.font = Resources.GetBuiltinResource<Font>("LegacyRuntime.ttf");
            textComponent.text = type.ToString();
            textComponent.color = Color.black;
            textComponent.fontSize = 12;
            textComponent.alignment = TextAnchor.MiddleCenter;

            var buttonLayout = buttonGO.AddComponent<LayoutElement>();
            buttonLayout.preferredHeight = 30;

            TerrainType capturedType = type;
            buttonComponent.onClick.AddListener(() => SelectTerrainType(capturedType));

            Debug.Log($"[TerrainTypePanel] Button {type}:");
            Debug.Log($"  - Position: {buttonRect.rect}");
            Debug.Log($"  - Anchors: min={buttonRect.anchorMin}, max={buttonRect.anchorMax}");
            Debug.Log($"  - Image raycastTarget: {buttonImage.raycastTarget}");
            Debug.Log($"  - Button interactable: {buttonComponent.interactable}");
            Debug.Log($"  - Button enabled: {buttonComponent.enabled}");
            Debug.Log($"  - GameObject active: {buttonGO.activeInHierarchy}");
            var parentName = buttonGO.transform.parent != null ? buttonGO.transform.parent.gameObject.name : "NULL";
            Debug.Log($"  - Parent: {parentName}");

            typeButtons[type] = buttonComponent;
        }

        Debug.Log($"[TerrainTypePanel] Created {typeButtons.Count} terrain type buttons");

        // Edge feature buttons (Cliff, River)
        var edgeButtonsGO = new GameObject("EdgeFeatureButtons");
        edgeButtonsGO.transform.SetParent(transform);
        var edgeLayout = edgeButtonsGO.AddComponent<VerticalLayoutGroup>();
        edgeLayout.spacing = 2f;
        edgeLayout.childForceExpandHeight = false;
        edgeLayout.childForceExpandWidth = true;

        foreach (EdgeFeature.EdgeFeatureType featureType in System.Enum.GetValues(typeof(EdgeFeature.EdgeFeatureType))) {
            var buttonGO = new GameObject(featureType.ToString());
            buttonGO.transform.SetParent(edgeButtonsGO.transform, false);

            var buttonRect = buttonGO.GetComponent<RectTransform>();
            if (buttonRect == null)
                buttonRect = buttonGO.AddComponent<RectTransform>();

            var buttonImage = buttonGO.AddComponent<Image>();
            // Use terrain type colors for edge features (Cliff = Cliffs, River = River)
            var terrainTypeForEdge = featureType == EdgeFeature.EdgeFeatureType.Cliff ? TerrainType.Cliffs : TerrainType.River;
            buttonImage.color = TerrainColors.For(terrainTypeForEdge);
            buttonImage.raycastTarget = true;

            var buttonComponent = buttonGO.AddComponent<Button>();
            buttonComponent.interactable = true;

            var buttonText = new GameObject("Text");
            buttonText.transform.SetParent(buttonGO.transform, false);
            var buttonTextRect = buttonText.GetComponent<RectTransform>();
            if (buttonTextRect == null)
                buttonTextRect = buttonText.AddComponent<RectTransform>();
            buttonTextRect.anchorMin = Vector2.zero;
            buttonTextRect.anchorMax = Vector2.one;
            buttonTextRect.offsetMin = Vector2.zero;
            buttonTextRect.offsetMax = Vector2.zero;

            var textComponent = buttonText.AddComponent<Text>();
            textComponent.font = Resources.GetBuiltinResource<Font>("LegacyRuntime.ttf");
            textComponent.text = featureType.ToString();
            textComponent.color = Color.white;
            textComponent.fontSize = 12;
            textComponent.alignment = TextAnchor.MiddleCenter;

            var buttonLayout = buttonGO.AddComponent<LayoutElement>();
            buttonLayout.preferredHeight = 30;

            EdgeFeature.EdgeFeatureType capturedType = featureType;
            buttonComponent.onClick.AddListener(() => SelectEdgeFeatureType(capturedType));

            edgeFeatureButtons[featureType] = buttonComponent;
        }

        Debug.Log($"[TerrainTypePanel] Created {edgeFeatureButtons.Count} edge feature buttons");

        // Description label
        var descLabelGO = new GameObject("DescriptionLabel");
        descLabelGO.transform.SetParent(transform);
        var descLabelText = descLabelGO.AddComponent<Text>();
        descLabelText.font = Resources.GetBuiltinResource<Font>("LegacyRuntime.ttf");
        descLabelText.text = "Description:";
        descLabelText.color = Color.white;
        descLabelText.fontSize = 12;
        var descLabelLayout = descLabelGO.AddComponent<LayoutElement>();
        descLabelLayout.preferredHeight = 20;

        // Description input
        var descInputGO = new GameObject("DescriptionInput");
        descInputGO.transform.SetParent(transform);
        var descInputBg = descInputGO.AddComponent<Image>();
        descInputBg.color = new Color(0.2f, 0.2f, 0.2f, 1f);

        descriptionInput = descInputGO.AddComponent<InputField>();
        descriptionInput.textComponent = CreateInputText(descInputGO);
        descriptionInput.characterValidation = InputField.CharacterValidation.None;
        var descInputLayout = descInputGO.AddComponent<LayoutElement>();
        descInputLayout.preferredHeight = 50;

        // Status text
        var statusGO = new GameObject("Status");
        statusGO.transform.SetParent(transform);
        statusText = statusGO.AddComponent<Text>();
        statusText.font = Resources.GetBuiltinResource<Font>("LegacyRuntime.ttf");
        statusText.text = "Ready";
        statusText.color = Color.gray;
        statusText.fontSize = 10;
        statusText.alignment = TextAnchor.UpperLeft;
        var statusLayout = statusGO.AddComponent<LayoutElement>();
        statusLayout.preferredHeight = 40;

        // Apply button
        var applyButtonGO = new GameObject("ApplyButton");
        applyButtonGO.transform.SetParent(transform);
        var applyButtonImage = applyButtonGO.AddComponent<Image>();
        applyButtonImage.color = new Color(0.2f, 0.4f, 0.6f);
        applyButton = applyButtonGO.AddComponent<Button>();
        var applyButtonText = new GameObject("Text");
        applyButtonText.transform.SetParent(applyButtonGO.transform);
        var applyText = applyButtonText.AddComponent<Text>();
        applyText.font = Resources.GetBuiltinResource<Font>("LegacyRuntime.ttf");
        applyText.text = "Apply";
        applyText.color = Color.white;
        applyText.fontSize = 12;
        applyText.alignment = TextAnchor.MiddleCenter;
        var applyLayout = applyButtonGO.AddComponent<LayoutElement>();
        applyLayout.preferredHeight = 30;

        applyButton.onClick.AddListener(() => ApplyTerrainSelection());
        Debug.Log("[TerrainTypePanel] Apply button created");

        // Done button
        var doneButtonGO = new GameObject("DoneButton");
        doneButtonGO.transform.SetParent(transform);
        var doneButtonImage = doneButtonGO.AddComponent<Image>();
        doneButtonImage.color = new Color(0.2f, 0.5f, 0.2f);
        doneButton = doneButtonGO.AddComponent<Button>();
        var doneButtonText = new GameObject("Text");
        doneButtonText.transform.SetParent(doneButtonGO.transform);
        var doneText = doneButtonText.AddComponent<Text>();
        doneText.font = Resources.GetBuiltinResource<Font>("LegacyRuntime.ttf");
        doneText.text = "Finish Terrain";
        doneText.color = Color.white;
        doneText.fontSize = 12;
        doneText.alignment = TextAnchor.MiddleCenter;
        var doneLayout = doneButtonGO.AddComponent<LayoutElement>();
        doneLayout.preferredHeight = 30;

        doneButton.onClick.AddListener(() => OnDoneClicked());
        Debug.Log("[TerrainTypePanel] SetupPanelLayout() COMPLETE");
    }

    private Text CreateInputText(GameObject parent) {
        var textGO = new GameObject("Text");
        textGO.transform.SetParent(parent.transform, false);

        // Set RectTransform to fill parent with padding
        var textRect = textGO.AddComponent<RectTransform>();
        textRect.anchorMin = Vector2.zero;
        textRect.anchorMax = Vector2.one;
        textRect.offsetMin = new Vector2(5, 5);
        textRect.offsetMax = new Vector2(-5, -5);

        var textComponent = textGO.AddComponent<Text>();
        textComponent.font = Resources.GetBuiltinResource<Font>("LegacyRuntime.ttf");
        textComponent.text = "";
        textComponent.color = Color.white;
        textComponent.fontSize = 12;
        textComponent.alignment = TextAnchor.UpperLeft;
        return textComponent;
    }

    private void SetupEventSubscriptions() {
        Debug.Log($"[TerrainTypePanel] Subscribing to events: {GameEvents.SETUP_PHASE_START}, {GameEvents.SETUP_PHASE_STEP_CHANGED}");
        EventSystem.Instance.Subscribe<object>(GameEvents.SETUP_PHASE_START, OnSetupPhaseStart);
        EventSystem.Instance.Subscribe<SetupPhaseStep>(GameEvents.SETUP_PHASE_STEP_CHANGED, OnSetupPhaseStepChanged);
        Debug.Log("[TerrainTypePanel] Event subscriptions complete");
    }

    private void OnSetupPhaseStart(object args) {
        Debug.Log("[TerrainTypePanel] *** OnSetupPhaseStart CALLBACK TRIGGERED ***");
        Show();
        Debug.Log("[TerrainTypePanel] Called edgeController.BeginEdgeSelection()");
        regionController.BeginTerrainSelection();
        edgeController.BeginEdgeSelection();
        UpdateStatus("Click regions to assign terrain, or select edges to create features");
    }

    private void OnSetupPhaseStepChanged(SetupPhaseStep step) {
        Debug.Log($"[TerrainTypePanel] OnSetupPhaseStepChanged: {step}");
        if (step == SetupPhaseStep.Terrain) {
            Show();
            regionController.BeginTerrainSelection();
            edgeController.BeginEdgeSelection();
            UpdateStatus("Click regions to assign terrain, or select edges to create features");
        } else {
            Hide();
            regionController.EndTerrainSelection();
            edgeController.EndEdgeSelection();
        }
    }

    private void OnDoneClicked() {
        Debug.Log("[TerrainTypePanel] OnDoneClicked");
        var selectedEdges = edgeController.GetSelectedEdges();
        Debug.Log($"[TerrainTypePanel] Selected edges: {selectedEdges.Count}");

        if (selectedEdges.Count > 0) {
            // User has edges selected - try to create edge feature
            var desc = descriptionInput.text ?? "";
            Debug.Log($"[TerrainTypePanel] Creating edge feature with description: '{desc}'");

            if (edgeController.TryCreateFeature(desc)) {
                descriptionInput.text = "";
                UpdateStatus("✓ Edge feature created");
            }
        } else {
            // No edges selected - finish terrain placement
            Debug.Log("[TerrainTypePanel] No edges selected, finishing terrain placement");
            SetupPhase.FinishTerrainPlacement();
            Hide();
            regionController.EndTerrainSelection();
            edgeController.EndEdgeSelection();
        }
    }

    private void UpdateStatus(string message) {
        statusText.text = message;
    }

    /// <summary>Called when a region is selected - switches to region mode</summary>
    public void OnRegionSelected() {
        if (regionSelected)
            return; // Already in region mode

        Debug.Log("[TerrainTypePanel] Region selected - switching to region mode");
        regionSelected = true;
        edgeSelected = false;
        currentMode = PanelMode.Region;

        // Deselect all edges
        edgeController.DeselectAllEdges();

        // Update button visibility
        UpdateButtonVisibility();
        UpdateStatus("Select terrain type for this region");
    }

    /// <summary>Called when edges are selected - switches to edge mode</summary>
    public void OnEdgeSelected() {
        if (edgeSelected)
            return; // Already in edge mode

        Debug.Log("[TerrainTypePanel] Edge selected - switching to edge mode");
        edgeSelected = true;
        regionSelected = false;
        currentMode = PanelMode.Edge;

        // Deselect the region
        regionController.DeselectRegion();

        // Update button visibility
        UpdateButtonVisibility();
        UpdateStatus("Select feature type for this edge (cliff/river)");
    }

    /// <summary>Called when edge selection changes to update button visibility (Cliff/River)</summary>
    public void UpdateEdgeButtonVisibility() {
        if (currentMode == PanelMode.Edge) {
            UpdateButtonVisibility();
        }
    }

    private void UpdateButtonVisibility() {
        // Region-only types: Plains, Desert, Hills, Mountains, Swamp, Forest, Delta, Lake, Sea
        var regionOnlyTypes = new[] {
            TerrainType.Plains, TerrainType.Mountains, TerrainType.Desert,
            TerrainType.Forest, TerrainType.Sea, //TerrainType.Delta,
            TerrainType.Hills, TerrainType.Swamp, TerrainType.Lake
        };

        // Show region buttons only in region mode
        foreach (var kvp in typeButtons) {
            bool isRegionType = System.Array.Exists(regionOnlyTypes, t => t == kvp.Key);
            kvp.Value.gameObject.SetActive(currentMode == PanelMode.Region && isRegionType);
        }

        // Show edge feature buttons in edge mode with restrictions
        if (currentMode == PanelMode.Edge) {
            var selectedEdges = edgeController.GetSelectedEdges();
            int edgeCount = selectedEdges.Count;

            // Cliffs: only for 1-2 edges
            if (edgeFeatureButtons.TryGetValue(EdgeFeature.EdgeFeatureType.Cliff, out var cliffButton)) {
                cliffButton.gameObject.SetActive(edgeCount <= 2);
            }

            // River: always available (validated during creation)
            if (edgeFeatureButtons.TryGetValue(EdgeFeature.EdgeFeatureType.River, out var riverButton)) {
                riverButton.gameObject.SetActive(true);
            }
        } else {
            // Hide edge buttons when not in edge mode
            foreach (var kvp in edgeFeatureButtons) {
                kvp.Value.gameObject.SetActive(false);
            }
        }
    }

    private void Show() {
        Debug.Log("[TerrainTypePanel] ========== Show() CALLED ==========");
        canvasGroup.alpha = 1f;
        canvasGroup.blocksRaycasts = false;  // Allow buttons to receive input

        // Disable city interaction during terrain setup
        var setupManager = SetupPhaseManager.Instance;
        if (setupManager != null && setupManager.CityViz != null) {
            setupManager.CityViz.enabled = false;
            Debug.Log("[TerrainTypePanel] Disabled CityVisualization");
        }

        Debug.Log($"[TerrainTypePanel] Panel GameObject active: {gameObject.activeInHierarchy}");
        Debug.Log($"[TerrainTypePanel] Panel position: {transform.position}");
        Debug.Log($"[TerrainTypePanel] Panel RectTransform: {GetComponent<RectTransform>().rect}");
        Debug.Log($"[TerrainTypePanel] CanvasGroup enabled: {canvasGroup.enabled}, blocksRaycasts: {canvasGroup.blocksRaycasts}");
        Debug.Log($"[TerrainTypePanel] Total buttons in typeButtons dict: {typeButtons.Count}");

        foreach (var kvp in typeButtons) {
            var type = kvp.Key;
            var button = kvp.Value;
            if (button != null) {
                Debug.Log($"[TerrainTypePanel] Button {type}:");
                Debug.Log($"  - GameObject active: {button.gameObject.activeInHierarchy}");
                Debug.Log($"  - Position: {button.GetComponent<RectTransform>().rect}");
                Debug.Log($"  - Interactable: {button.interactable}");
                Debug.Log($"  - Enabled: {button.enabled}");
                Debug.Log($"  - Image raycastTarget: {button.GetComponent<Image>().raycastTarget}");
            } else {
                Debug.LogWarning($"[TerrainTypePanel] Button {type} is NULL!");
            }
        }
        Debug.Log("[TerrainTypePanel] ========== Show() COMPLETE ==========");
    }

    private void Hide() {
        canvasGroup.alpha = 0f;
        canvasGroup.blocksRaycasts = false;

        // Re-enable city interaction after terrain setup
        var setupManager = SetupPhaseManager.Instance;
        if (setupManager != null && setupManager.CityViz != null) {
            setupManager.CityViz.enabled = true;
            Debug.Log("[TerrainTypePanel] Re-enabled CityVisualization");
        }
    }

    /// <summary>
    /// Check if a screen position is over ANY part of the panel (buttons, input field, etc).
    /// Called by TerrainSelectionController and EdgeSelectionController to prevent world clicks when clicking panel.
    /// </summary>
    public bool IsClickOverPanel(Vector2 screenPos) {
        if (!gameObject.activeInHierarchy || canvasGroup.alpha == 0f)
            return false;

        var panelRect = GetComponent<RectTransform>();
        var canvas = GetComponentInParent<Canvas>();
        if (canvas == null)
            return false;

        bool isOver = RectTransformUtility.RectangleContainsScreenPoint(panelRect, screenPos, canvas.worldCamera);
        //Debug.Log($"[TerrainTypePanel.IsClickOverPanel] screenPos={screenPos}, panelRect={panelRect.rect}, isOver={isOver}");
        return isOver;
    }

    /// <summary>When a terrain type button is clicked, just select the type (don't apply yet).</summary>
    private void SelectTerrainType(TerrainType type) {
        selectedTerrainType = type;
        Debug.Log($"[TerrainTypePanel] Selected terrain type: {type}");
        UpdateStatus($"Selected: {type} — enter description and click Apply");

        // Focus the description input so user can type
        descriptionInput.ActivateInputField();
    }

    /// <summary>When an edge feature type button is clicked, select it.</summary>
    private void SelectEdgeFeatureType(EdgeFeature.EdgeFeatureType type) {
        selectedEdgeFeatureType = type;
        edgeController.SetFeatureType(type);
        Debug.Log($"[TerrainTypePanel] Selected edge feature type: {type}");
        UpdateStatus($"Selected: {type} — click Done to apply");
    }

    /// <summary>Apply the selected type (region terrain or edge feature).</summary>
    private void ApplyTerrainSelection() {
        Debug.Log("[TerrainTypePanel] ApplyTerrainSelection() CALLED");

        var selectedRegion = regionController.GetSelectedRegion();
        var selectedEdges = edgeController.GetSelectedEdges();

        // Handle edge features
        if (selectedEdges.Count > 0) {
            Debug.Log($"[TerrainTypePanel] Applying edge feature {selectedEdgeFeatureType} to {selectedEdges.Count} edges");
            string description = descriptionInput.text ?? "";

            if (edgeController.TryCreateFeature(description)) {
                descriptionInput.text = "";
                UpdateStatus($"✓ {selectedEdgeFeatureType} created");
            } else {
                UpdateStatus("Failed to create edge feature");
            }
            return;
        }

        // Handle region terrain
        if (selectedRegion == null) {
            UpdateStatus("Select a region or edges first");
            Debug.Log("[TerrainTypePanel] No region or edges selected");
            return;
        }

        string regionDescription = descriptionInput.text ?? ""; // Description is optional
        Debug.Log($"[TerrainTypePanel] Applying terrain {selectedTerrainType} to region {selectedRegion.Id} with description '{regionDescription}'");
        regionController.AssignTerrain(selectedTerrainType, regionDescription);
        descriptionInput.text = "";
        UpdateStatus($"✓ {selectedTerrainType} placed");
    }
}

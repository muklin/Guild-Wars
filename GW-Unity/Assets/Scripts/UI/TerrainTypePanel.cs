using UnityEngine;
using UnityEngine.UI;
using System.Collections.Generic;

/// <summary>
/// UI panel for terrain setup. Displays terrain type buttons and description input.
/// Shows during Session Zero terrain step only.
/// </summary>
public class TerrainTypePanel : MonoBehaviour {
    private TerrainSelectionController regionController;
    private EdgeSelectionController edgeController;
    private SessionZeroPhase sessionZero;
    private TerrainType selectedType = TerrainType.Plains;
    private bool inEdgeSelectionMode = false;
    private CanvasGroup canvasGroup;

    // UI Elements
    private InputField descriptionInput;
    private Text statusText;
    private Button doneButton;
    private Button toggleModeButton;
    private Dictionary<TerrainType, Button> typeButtons = new();
    private Dictionary<string, Button> edgeTypeButtons = new();

    public void Initialize(TerrainSelectionController regionController, EdgeSelectionController edgeController, SessionZeroPhase sessionZero) {
        this.regionController = regionController;
        this.edgeController = edgeController;
        this.sessionZero = sessionZero;

        SetupPanelLayout();
        SetupEventSubscriptions();

        // Hidden by default, shown when Session Zero starts
        canvasGroup.alpha = 0f;
        canvasGroup.blocksRaycasts = false;
    }

    private void SetupPanelLayout() {
        var rectTransform = GetComponent<RectTransform>();
        rectTransform.anchorMin = new Vector2(0, 0);
        rectTransform.anchorMax = new Vector2(0, 1);
        rectTransform.offsetMin = Vector2.zero;
        rectTransform.offsetMax = new Vector2(200, 0);

        // Panel background
        var bgImage = gameObject.AddComponent<Image>();
        bgImage.color = new Color(0.1f, 0.1f, 0.1f, 0.9f);

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
        headerText.font = Resources.GetBuiltinResource<Font>("Arial.ttf");
        headerText.text = "Terrain Setup";
        headerText.font.RequestCharactersInTexture(headerText.text);
        headerText.color = Color.white;
        headerText.fontSize = 16;
        headerText.fontStyle = FontStyle.Bold;
        headerText.alignment = TextAnchor.MiddleCenter;
        var headerLayout = headerGO.AddComponent<LayoutElement>();
        headerLayout.preferredHeight = 30;

        // Mode toggle button
        var toggleGO = new GameObject("ModeToggle");
        toggleGO.transform.SetParent(transform);
        var toggleBg = toggleGO.AddComponent<Image>();
        toggleBg.color = new Color(0.3f, 0.3f, 0.3f);
        toggleModeButton = toggleGO.AddComponent<Button>();
        toggleModeButton.onClick.AddListener(ToggleSelectionMode);
        var toggleText = new GameObject("Text");
        toggleText.transform.SetParent(toggleGO.transform);
        var toggleTextComp = toggleText.AddComponent<Text>();
        toggleTextComp.font = Resources.GetBuiltinResource<Font>("Arial.ttf");
        toggleTextComp.text = "→ Edge Mode";
        toggleTextComp.fontSize = 12;
        toggleTextComp.color = Color.white;
        toggleTextComp.alignment = TextAnchor.MiddleCenter;
        var toggleLayout = toggleGO.AddComponent<LayoutElement>();
        toggleLayout.preferredHeight = 30;

        // Terrain type buttons
        var typeButtonsGO = new GameObject("TypeButtons");
        typeButtonsGO.transform.SetParent(transform);
        var typeLayout = typeButtonsGO.AddComponent<VerticalLayoutGroup>();
        typeLayout.spacing = 2f;
        typeLayout.childForceExpandHeight = false;
        typeLayout.childForceExpandWidth = true;

        foreach (TerrainType type in System.Enum.GetValues(typeof(TerrainType))) {
            var buttonGO = new GameObject(type.ToString());
            buttonGO.transform.SetParent(typeButtonsGO.transform);

            var buttonImage = buttonGO.AddComponent<Image>();
            buttonImage.color = TerrainColors.For(type);

            var buttonComponent = buttonGO.AddComponent<Button>();
            var colors = buttonComponent.colors;
            colors.normalColor = TerrainColors.For(type);
            colors.highlightedColor = Color.white;
            colors.pressedColor = Color.yellow;
            colors.disabledColor = new Color(0.5f, 0.5f, 0.5f);
            buttonComponent.colors = colors;

            var buttonText = new GameObject("Text");
            buttonText.transform.SetParent(buttonGO.transform);
            var textComponent = buttonText.AddComponent<Text>();
            textComponent.font = Resources.GetBuiltinResource<Font>("Arial.ttf");
            textComponent.text = type.ToString();
            textComponent.color = Color.black;
            textComponent.fontSize = 12;
            textComponent.alignment = TextAnchor.MiddleCenter;

            var buttonLayout = buttonGO.AddComponent<LayoutElement>();
            buttonLayout.preferredHeight = 30;

            TerrainType capturedType = type;
            buttonComponent.onClick.AddListener(() => OnTypeSelected(capturedType));

            typeButtons[type] = buttonComponent;
        }

        // Description label
        var descLabelGO = new GameObject("DescriptionLabel");
        descLabelGO.transform.SetParent(transform);
        var descLabelText = descLabelGO.AddComponent<Text>();
        descLabelText.font = Resources.GetBuiltinResource<Font>("Arial.ttf");
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
        statusText.font = Resources.GetBuiltinResource<Font>("Arial.ttf");
        statusText.text = "Click a region to select it";
        statusText.color = Color.gray;
        statusText.fontSize = 10;
        statusText.alignment = TextAnchor.UpperLeft;
        var statusLayout = statusGO.AddComponent<LayoutElement>();
        statusLayout.preferredHeight = 40;

        // Done button
        var doneButtonGO = new GameObject("DoneButton");
        doneButtonGO.transform.SetParent(transform);
        var doneButtonImage = doneButtonGO.AddComponent<Image>();
        doneButtonImage.color = new Color(0.2f, 0.5f, 0.2f);
        doneButton = doneButtonGO.AddComponent<Button>();
        var doneButtonText = new GameObject("Text");
        doneButtonText.transform.SetParent(doneButtonGO.transform);
        var doneText = doneButtonText.AddComponent<Text>();
        doneText.font = Resources.GetBuiltinResource<Font>("Arial.ttf");
        doneText.text = "Finish Terrain";
        doneText.color = Color.white;
        doneText.fontSize = 12;
        doneText.alignment = TextAnchor.MiddleCenter;
        var doneLayout = doneButtonGO.AddComponent<LayoutElement>();
        doneLayout.preferredHeight = 30;

        doneButton.onClick.AddListener(() => OnDoneClicked());
    }

    private Text CreateInputText(GameObject parent) {
        var textGO = new GameObject("Text");
        textGO.transform.SetParent(parent.transform);
        var textComponent = textGO.AddComponent<Text>();
        textComponent.font = Resources.GetBuiltinResource<Font>("Arial.ttf");
        textComponent.text = "";
        textComponent.color = Color.white;
        textComponent.fontSize = 12;
        textComponent.alignment = TextAnchor.UpperLeft;
        return textComponent;
    }

    private void SetupEventSubscriptions() {
        EventSystem.Instance.Subscribe<object>(GameEvents.SESSION_ZERO_START, OnSessionZeroStart);
        EventSystem.Instance.Subscribe<SessionZeroStep>(GameEvents.SESSION_ZERO_STEP_CHANGED, OnSessionZeroStepChanged);
    }

    private void OnSessionZeroStart(object args) {
        Show();
        EnterRegionMode();
    }

    private void OnSessionZeroStepChanged(SessionZeroStep step) {
        if (step == SessionZeroStep.Terrain) {
            Show();
            EnterRegionMode();
        } else {
            Hide();
            regionController.EndTerrainSelection();
            edgeController.EndEdgeSelection();
        }
    }

    private void EnterRegionMode() {
        inEdgeSelectionMode = false;
        regionController.BeginTerrainSelection();
        edgeController.EndEdgeSelection();
        UpdateStatus("Click a region to select it");
        toggleModeButton.GetComponentInChildren<Text>().text = "→ Edge Mode";
    }

    private void EnterEdgeMode() {
        inEdgeSelectionMode = true;
        regionController.EndTerrainSelection();
        edgeController.BeginEdgeSelection();
        UpdateStatus("Click edges to create cliffs/rivers");
        toggleModeButton.GetComponentInChildren<Text>().text = "→ Region Mode";
    }

    private void ToggleSelectionMode() {
        if (inEdgeSelectionMode)
            EnterRegionMode();
        else
            EnterEdgeMode();
    }

    private void OnTypeSelected(TerrainType type) {
        if (inEdgeSelectionMode)
            return; // Ignore terrain type selection in edge mode

        var selectedRegion = regionController.GetSelectedRegion();
        if (selectedRegion == null) {
            UpdateStatus("Select a region first!");
            return;
        }

        if (string.IsNullOrWhiteSpace(descriptionInput.text)) {
            UpdateStatus("Enter a description first!");
            return;
        }

        selectedType = type;
        regionController.AssignTerrain(type, descriptionInput.text);
        descriptionInput.text = "";
        UpdateStatus("✓ Terrain placed");
    }

    private void OnDoneClicked() {
        if (inEdgeSelectionMode) {
            // User clicked Done while in edge mode - try to create edge feature
            var desc = descriptionInput.text;
            if (string.IsNullOrWhiteSpace(desc)) {
                UpdateStatus("Enter a description");
                return;
            }

            if (edgeController.TryCreateFeature(desc)) {
                descriptionInput.text = "";
                UpdateStatus("Edge feature created. Select another.");
            }
        } else {
            sessionZero.FinishTerrainPlacement();
            Hide();
            regionController.EndTerrainSelection();
            edgeController.EndEdgeSelection();
        }
    }

    private void UpdateStatus(string message) {
        statusText.text = message;
    }

    private void Show() {
        canvasGroup.alpha = 1f;
        canvasGroup.blocksRaycasts = true;
    }

    private void Hide() {
        canvasGroup.alpha = 0f;
        canvasGroup.blocksRaycasts = false;
    }
}

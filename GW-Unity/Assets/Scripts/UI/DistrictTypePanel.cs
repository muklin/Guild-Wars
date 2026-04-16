using UnityEngine;
using UnityEngine.UI;
using System.Collections.Generic;

/// <summary>
/// UI panel for classifying city districts.
/// Appears during the CitySubdivision step and allows users to assign DistrictClass types to selected districts.
/// </summary>
public class DistrictTypePanel : MonoBehaviour {
    private CityDistrictSelectionController selectionController;
    private SetupPhase setupPhase;
    private CanvasGroup canvasGroup;
    private InputField descriptionInput;
    private Text statusText;
    private Button applyButton;
    private Button doneButton;
    private Dictionary<DistrictClass, Button> classButtons = new();
    private DistrictClass selectedClass = DistrictClass.Neutral;

    public void Initialize(CityDistrictSelectionController controller, SetupPhase setupPhase) {
        this.selectionController = controller;
        this.setupPhase = setupPhase;

        SetupPanelLayout();
        SetupEventSubscriptions();

        // Start hidden
        canvasGroup = GetComponent<CanvasGroup>();
        if (canvasGroup == null)
            canvasGroup = gameObject.AddComponent<CanvasGroup>();
        canvasGroup.alpha = 0f;
        canvasGroup.blocksRaycasts = false;
    }

    public void OnDistrictSelected() {
        // Panel is already visible and ready to interact
    }

    public bool IsClickOverPanel(Vector2 screenPos) {
        RectTransformUtility.ScreenPointToLocalPointInRectangle(
            GetComponent<RectTransform>(),
            screenPos,
            null,
            out Vector2 localPos
        );

        return GetComponent<RectTransform>().rect.Contains(localPos);
    }

    private void SetupPanelLayout() {
        var rectTransform = gameObject.AddComponent<RectTransform>();
        rectTransform.anchorMin = Vector2.zero;
        rectTransform.anchorMax = new Vector2(0, 1);
        rectTransform.offsetMin = Vector2.zero;
        rectTransform.offsetMax = new Vector2(200, 0);

        var image = gameObject.AddComponent<Image>();
        image.color = new Color(0.1f, 0.1f, 0.1f, 0.9f);

        var layoutGroup = gameObject.AddComponent<VerticalLayoutGroup>();
        layoutGroup.spacing = 4f;
        layoutGroup.padding = new RectOffset(8, 8, 8, 8);
        layoutGroup.childForceExpandWidth = true;
        layoutGroup.childForceExpandHeight = false;

        // Header
        var headerGO = new GameObject("Header");
        headerGO.transform.SetParent(transform, false);
        var headerText = headerGO.AddComponent<Text>();
        headerText.font = Resources.GetBuiltinResource<Font>("Arial.ttf");
        headerText.text = "District Setup";
        headerText.font = Resources.GetBuiltinResource<Font>("Arial.ttf");
        headerText.fontSize = 16;
        headerText.fontStyle = FontStyle.Bold;
        headerText.color = Color.white;
        headerText.alignment = TextAnchor.MiddleCenter;
        var headerLE = headerGO.AddComponent<LayoutElement>();
        headerLE.preferredHeight = 28;

        // Buttons container for district class buttons
        var buttonsContainerGO = new GameObject("ClassButtonsContainer");
        buttonsContainerGO.transform.SetParent(transform, false);
        var buttonsLayout = buttonsContainerGO.AddComponent<GridLayoutGroup>();
        buttonsLayout.cellSize = new Vector2(90, 24);
        buttonsLayout.spacing = new Vector2(4, 4);
        buttonsLayout.constraint = GridLayoutGroup.Constraint.FixedColumnCount;
        buttonsLayout.constraintCount = 2;
        var buttonsContainerLE = buttonsContainerGO.AddComponent<LayoutElement>();
        buttonsContainerLE.preferredHeight = 140;

        // Create button for each DistrictClass
        foreach (DistrictClass cls in System.Enum.GetValues(typeof(DistrictClass))) {
            var btnGO = new GameObject(cls.ToString());
            btnGO.transform.SetParent(buttonsContainerGO.transform, false);

            var btn = btnGO.AddComponent<Button>();
            var btnImage = btnGO.AddComponent<Image>();
            btnImage.color = DistrictColors.For(cls);
            btn.targetGraphic = btnImage;

            var btnText = btnGO.AddComponent<Text>();
            btnText.font = Resources.GetBuiltinResource<Font>("Arial.ttf");
            btnText.text = cls.ToString();
            btnText.fontSize = 10;
            btnText.alignment = TextAnchor.MiddleCenter;
            btnText.color = Color.white;

            var btnLE = btnGO.AddComponent<LayoutElement>();
            btnLE.preferredWidth = 90;
            btnLE.preferredHeight = 24;

            DistrictClass capturedCls = cls;
            btn.onClick.AddListener(() => OnClassButtonClicked(capturedCls));
            classButtons[cls] = btn;
        }

        // Description label
        var descLabelGO = new GameObject("DescriptionLabel");
        descLabelGO.transform.SetParent(transform, false);
        var descLabel = descLabelGO.AddComponent<Text>();
        descLabel.font = Resources.GetBuiltinResource<Font>("Arial.ttf");
        descLabel.text = "Description:";
        descLabel.fontSize = 12;
        descLabel.color = Color.white;
        var descLabelLE = descLabelGO.AddComponent<LayoutElement>();
        descLabelLE.preferredHeight = 18;

        // Description input
        var descInputGO = new GameObject("DescriptionInput");
        descInputGO.transform.SetParent(transform, false);
        var descInputImage = descInputGO.AddComponent<Image>();
        descInputImage.color = Color.white;
        descriptionInput = descInputGO.AddComponent<InputField>();
        var descInputText = descInputGO.AddComponent<Text>();
        descInputText.font = Resources.GetBuiltinResource<Font>("Arial.ttf");
        descInputText.fontSize = 12;
        descInputText.color = Color.black;
        descriptionInput.textComponent = descInputText;
        var descInputLE = descInputGO.AddComponent<LayoutElement>();
        descInputLE.preferredHeight = 40;

        // Status text
        var statusGO = new GameObject("StatusText");
        statusGO.transform.SetParent(transform, false);
        statusText = statusGO.AddComponent<Text>();
        statusText.font = Resources.GetBuiltinResource<Font>("Arial.ttf");
        statusText.text = "Select a district to classify";
        statusText.fontSize = 10;
        statusText.color = Color.yellow;
        var statusLE = statusGO.AddComponent<LayoutElement>();
        statusLE.preferredHeight = 18;

        // Apply button
        var applyBtnGO = new GameObject("ApplyButton");
        applyBtnGO.transform.SetParent(transform, false);
        var applyBtnImage = applyBtnGO.AddComponent<Image>();
        applyBtnImage.color = new Color(0.2f, 0.6f, 1.0f); // blue
        applyButton = applyBtnGO.AddComponent<Button>();
        applyButton.targetGraphic = applyBtnImage;
        var applyBtnText = applyBtnGO.AddComponent<Text>();
        applyBtnText.font = Resources.GetBuiltinResource<Font>("Arial.ttf");
        applyBtnText.text = "Assign";
        applyBtnText.fontSize = 12;
        applyBtnText.color = Color.white;
        applyBtnText.alignment = TextAnchor.MiddleCenter;
        applyButton.onClick.AddListener(OnApplyClicked);
        var applyBtnLE = applyBtnGO.AddComponent<LayoutElement>();
        applyBtnLE.preferredHeight = 28;

        // Done button
        var doneBtnGO = new GameObject("DoneButton");
        doneBtnGO.transform.SetParent(transform, false);
        var doneBtnImage = doneBtnGO.AddComponent<Image>();
        doneBtnImage.color = new Color(0.2f, 0.8f, 0.2f); // green
        doneButton = doneBtnGO.AddComponent<Button>();
        doneButton.targetGraphic = doneBtnImage;
        var doneBtnText = doneBtnGO.AddComponent<Text>();
        doneBtnText.font = Resources.GetBuiltinResource<Font>("Arial.ttf");
        doneBtnText.text = "Finish Districts";
        doneBtnText.fontSize = 12;
        doneBtnText.color = Color.white;
        doneBtnText.alignment = TextAnchor.MiddleCenter;
        doneButton.onClick.AddListener(OnDoneClicked);
        var doneBtnLE = doneBtnGO.AddComponent<LayoutElement>();
        doneBtnLE.preferredHeight = 28;
    }

    private void SetupEventSubscriptions() {
        EventSystem.Instance?.Subscribe(GameEvents.SETUP_PHASE_STEP_CHANGED, OnSetupPhaseStepChanged);
    }

    private void OnSetupPhaseStepChanged(SetupPhaseStep step) {
        if (step == SetupPhaseStep.CitySubdivision) {
            Show();
        } else {
            Hide();
        }
    }

    private void OnClassButtonClicked(DistrictClass cls) {
        selectedClass = cls;
        statusText.text = $"Selected: {cls}";
    }

    private void OnApplyClicked() {
        selectionController.AssignDistrictClass(selectedClass, descriptionInput.text);
        descriptionInput.text = "";
        statusText.text = "District assigned. Select another or finish.";
    }

    private void OnDoneClicked() {
        selectionController.EndDistrictSelection();
        setupPhase.FinishCitySubdivision();
        Hide();
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

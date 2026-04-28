using UnityEngine;
using UnityEngine.UI;
using System.Collections;

/// <summary>
/// Displays error messages in a modal popup.
/// Messages auto-dismiss after a timeout or can be manually dismissed.
/// </summary>
public class ErrorPopupPanel : UIPanel
{
    private Text errorMessageText;
    private Button dismissButton;
    private Image backgroundImage;
    private Coroutine autoDismissCoroutine;
    private const float AUTO_DISMISS_DELAY = 5f;

    public override void Initialize()
    {
        // Create panel background (modal overlay effect)
        backgroundImage = gameObject.AddComponent<Image>();
        backgroundImage.color = new Color(0, 0, 0, 0.5f); // Semi-transparent black

        // Create error box (40% width/height, centered horizontally, 33% from top)
        var errorBox = new GameObject("ErrorBox");
        errorBox.transform.SetParent(gameObject.transform, false);
        var boxImage = errorBox.AddComponent<Image>();
        boxImage.color = new Color(0.2f, 0.1f, 0.1f, 0.95f); // Dark reddish background
        var boxRect = errorBox.GetComponent<RectTransform>();

        // 40% width/height, centered horizontally (30%-70%), positioned at 33% from top (67% from bottom)
        boxRect.anchorMin = new Vector2(0.3f, 0.47f);
        boxRect.anchorMax = new Vector2(0.7f, 0.87f);
        boxRect.offsetMin = Vector2.zero;
        boxRect.offsetMax = Vector2.zero;

        // Add layout group for content
        var layout = errorBox.AddComponent<VerticalLayoutGroup>();
        layout.padding = new RectOffset(20, 20, 20, 20);
        layout.spacing = 15;
        layout.childForceExpandHeight = false;
        layout.childForceExpandWidth = true;

        // Error message text
        errorMessageText = new GameObject("ErrorMessage").AddComponent<Text>();
        errorMessageText.transform.SetParent(errorBox.transform, false);
        errorMessageText.font = Resources.GetBuiltinResource<Font>("LegacyRuntime.ttf");
        errorMessageText.fontSize = 20;
        errorMessageText.fontStyle = FontStyle.Bold;
        errorMessageText.alignment = TextAnchor.MiddleCenter;
        errorMessageText.color = new Color(1f, 0.4f, 0.4f); // Light red text
        var msgRect = errorMessageText.GetComponent<RectTransform>();
        msgRect.sizeDelta = new Vector2(0, 100);
        var msgLayoutElement = errorMessageText.gameObject.AddComponent<LayoutElement>();
        msgLayoutElement.preferredHeight = 100;

        // Dismiss button
        dismissButton = CreateDismissButton(errorBox.transform);

        rectTransform = GetComponent<RectTransform>();
    }

    private Button CreateDismissButton(Transform parent)
    {
        var buttonObj = new GameObject("DismissButton");
        buttonObj.transform.SetParent(parent, false);

        var buttonImg = buttonObj.AddComponent<Image>();
        buttonImg.color = new Color(0.4f, 0.2f, 0.2f, 1f);

        var button = buttonObj.AddComponent<Button>();
        button.onClick.AddListener(OnDismiss);

        var textObj = new GameObject("Text");
        textObj.transform.SetParent(buttonObj.transform, false);
        var textComponent = textObj.AddComponent<Text>();
        textComponent.text = "OK";
        textComponent.font = Resources.GetBuiltinResource<Font>("LegacyRuntime.ttf");
        textComponent.fontSize = 20;
        textComponent.fontStyle = FontStyle.Bold;
        textComponent.alignment = TextAnchor.MiddleCenter;
        textComponent.color = Color.white;

        var textRect = textObj.GetComponent<RectTransform>();
        textRect.anchorMin = Vector2.zero;
        textRect.anchorMax = Vector2.one;
        textRect.offsetMin = Vector2.zero;
        textRect.offsetMax = Vector2.zero;

        var buttonRect = buttonObj.GetComponent<RectTransform>();
        buttonRect.sizeDelta = new Vector2(100, 45);
        var layoutElement = buttonObj.AddComponent<LayoutElement>();
        layoutElement.preferredWidth = 100;
        layoutElement.preferredHeight = 45;

        return button;
    }

    public void ShowError(string message, float dismissDelay = AUTO_DISMISS_DELAY)
    {
        errorMessageText.text = message;
        ShowPanel();

        // Cancel previous auto-dismiss
        if (autoDismissCoroutine != null)
        {
            StopCoroutine(autoDismissCoroutine);
        }

        // Schedule auto-dismiss
        autoDismissCoroutine = StartCoroutine(AutoDismissCoroutine(dismissDelay));
        Debug.Log($"[ErrorPopupPanel] Showing error: {message}");
    }

    private void OnDismiss()
    {
        if (autoDismissCoroutine != null)
        {
            StopCoroutine(autoDismissCoroutine);
            autoDismissCoroutine = null;
        }
        HidePanel();
    }

    private IEnumerator AutoDismissCoroutine(float delay)
    {
        yield return new WaitForSeconds(delay);
        HidePanel();
    }
}

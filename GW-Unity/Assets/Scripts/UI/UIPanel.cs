using UnityEngine;

/// <summary>
/// Base class for all UI panels in GuildWars.
/// Handles common functionality like Initialize, Show, Hide, Layout.
/// </summary>
public abstract class UIPanel : MonoBehaviour
{
    protected RectTransform rectTransform;
    protected LayoutGroup layoutGroup;
    protected bool isVisible = false;

    public virtual void Initialize()
    {
        rectTransform = GetComponent<RectTransform>();
        layoutGroup = GetComponent<LayoutGroup>();

        // Set up layout
        if (layoutGroup == null)
        {
            var verticalLayout = gameObject.AddComponent<VerticalLayoutGroup>();
            layoutGroup = verticalLayout;
            verticalLayout.childForceExpandHeight = true;
            verticalLayout.childForceExpandWidth = true;
        }

        // Add background
        var img = gameObject.AddComponent<Image>();
        img.color = new Color(0, 0, 0, 0.8f);

        RefreshLayout();
    }

    public virtual void ShowPanel()
    {
        gameObject.SetActive(true);
        isVisible = true;
        Debug.Log($"[UIPanel] {gameObject.name} shown");
    }

    public virtual void HidePanel()
    {
        gameObject.SetActive(false);
        isVisible = false;
    }

    public virtual void Refresh()
    {
        RefreshLayout();
    }

    protected virtual void RefreshLayout()
    {
        LayoutRebuilder.ForceRebuildLayoutImmediate(rectTransform);
    }

    protected GameObject CreateTextObject(string name, string text, Transform parent, int fontSize = 30)
    {
        var textObj = new GameObject(name);
        textObj.transform.SetParent(parent, false);

        var textComponent = textObj.AddComponent<Text>();
        textComponent.text = text;
        textComponent.font = Resources.GetBuiltinResource<Font>("LegacyRuntime.ttf");
        textComponent.fontSize = fontSize;
        textComponent.fontStyle = FontStyle.Normal;
        textComponent.alignment = TextAnchor.MiddleLeft;
        textComponent.color = Color.white;

        var textRectTransform = textObj.GetComponent<RectTransform>();
        textRectTransform.sizeDelta = new Vector2(400, 50);

        return textObj;
    }

    protected GameObject CreateButtonWithText(string name, string buttonText, Transform parent, UnityEngine.Events.UnityAction onClick)
    {
        var buttonObj = new GameObject(name);
        buttonObj.transform.SetParent(parent, false);

        // Button image
        var buttonImg = buttonObj.AddComponent<Image>();
        buttonImg.color = new Color(0.2f, 0.2f, 0.2f, 1f);

        // Button component
        var button = buttonObj.AddComponent<Button>();
        button.onClick.AddListener(onClick);

        // Text
        var textObj = new GameObject("Text");
        textObj.transform.SetParent(buttonObj.transform, false);
        var textComponent = textObj.AddComponent<Text>();
        textComponent.text = buttonText;
        textComponent.font = Resources.GetBuiltinResource<Font>("LegacyRuntime.ttf");
        textComponent.fontSize = 24;
        textComponent.fontStyle = FontStyle.Bold;
        textComponent.alignment = TextAnchor.MiddleCenter;
        textComponent.color = Color.white;

        var textRectTransform = textObj.GetComponent<RectTransform>();
        textRectTransform.anchorMin = Vector2.zero;
        textRectTransform.anchorMax = Vector2.one;
        textRectTransform.offsetMin = Vector2.zero;
        textRectTransform.offsetMax = Vector2.zero;

        var buttonRectTransform = buttonObj.GetComponent<RectTransform>();
        buttonRectTransform.sizeDelta = new Vector2(150, 50);

        return buttonObj;
    }

    protected GameObject CreatePanel(string name, Transform parent, Color backgroundColor)
    {
        var panelObj = new GameObject(name);
        panelObj.transform.SetParent(parent, false);

        var img = panelObj.AddComponent<Image>();
        img.color = backgroundColor;

        var layout = panelObj.AddComponent<VerticalLayoutGroup>();
        layout.padding = new RectOffset(10, 10, 10, 10);
        layout.spacing = 5;
        layout.childForceExpandHeight = false;
        layout.childForceExpandWidth = true;

        return panelObj;
    }
}

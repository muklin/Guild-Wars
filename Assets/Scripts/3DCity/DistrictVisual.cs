using UnityEngine;

/// <summary>
/// Visual representation of a district in the city.
/// Initially a colored box placeholder; will be replaced with FBX models later.
/// </summary>
public class DistrictVisual : MonoBehaviour
{
    private int districtId;
    private District districtData;
    private MeshRenderer meshRenderer;
    private BoxCollider boxCollider;
    private Material originalMaterial;
    private Material selectedMaterial;

    [SerializeField] private Color neutralColor = Color.gray;
    [SerializeField] private Color selectedColor = Color.yellow;

    public void Initialize(District district)
    {
        districtData = district;
        districtId = district.Id;

        gameObject.name = $"District_{district.Name}";
        gameObject.transform.position = district.WorldPosition;

        // Create box if not already present
        if (GetComponent<MeshFilter>() == null)
        {
            gameObject.AddComponent<MeshFilter>();
            gameObject.AddComponent<BoxCollider>();
        }

        meshRenderer = GetComponent<MeshRenderer>();
        boxCollider = GetComponent<BoxCollider>();

        // Create materials
        originalMaterial = new Material(Shader.Find("Standard"));
        selectedMaterial = new Material(Shader.Find("Standard"));
        selectedMaterial.color = selectedColor;

        UpdateColor();
    }

    public void UpdateColor()
    {
        if (meshRenderer == null) return;

        Color color = neutralColor;

        // Change color based on controller
        if (districtData != null && districtData.IsControlled())
        {
            var guild = GameStateManager.Instance?.GetGuild(districtData.ControllingGuildId);
            if (guild != null)
            {
                // Generate color from guild ID
                color = GetColorFromId(guild.Id);
            }
        }

        originalMaterial.color = color;
        meshRenderer.material = originalMaterial;
    }

    public void Select()
    {
        meshRenderer.material = selectedMaterial;
    }

    public void Deselect()
    {
        UpdateColor();
    }

    public int GetDistrictId()
    {
        return districtId;
    }

    public District GetDistrictData()
    {
        return districtData;
    }

    private Color GetColorFromId(int id)
    {
        // Generate deterministic color from ID
        int seed = id;
        Random.InitState(seed);
        return new Color(Random.value, Random.value, Random.value);
    }

    private void OnMouseEnter()
    {
        // Could add hover effect here
    }

    private void OnMouseExit()
    {
        // Could remove hover effect here
    }
}

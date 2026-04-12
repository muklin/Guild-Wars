using UnityEngine;

/// <summary>
/// Represents a clickable edge between two Voronoi regions.
/// Users can select edges to create cliffs and rivers.
/// </summary>
public class VoronoiEdge : MonoBehaviour
{
    public int id;
    public int regionA;
    public int regionB;
    public Vector3 edgeStartPoint;
    public Vector3 edgeEndPoint;

    private Material highlightMaterial;
    private Material normalMaterial;
    private MeshRenderer meshRenderer;
    private Color normalColor = new Color(1f, 1f, 1f, 0.3f); // Transparent white
    private Color highlightColor = new Color(1f, 1f, 0f, 0.8f); // Bright yellow

    public void Initialize(int edgeId, int a, int b, Vector3 start, Vector3 end)
    {
        id = edgeId;
        regionA = a;
        regionB = b;
        edgeStartPoint = start;
        edgeEndPoint = end;

        meshRenderer = GetComponent<MeshRenderer>();
        if (meshRenderer != null)
        {
            normalMaterial = meshRenderer.material;
            // Create highlight material
            highlightMaterial = new Material(Shader.Find("Unlit/Color"));
            highlightMaterial.color = highlightColor;
        }
    }

    public void Highlight()
    {
        if (meshRenderer != null && highlightMaterial != null)
            meshRenderer.material = highlightMaterial;
    }

    public void ClearHighlight()
    {
        if (meshRenderer != null && normalMaterial != null)
            meshRenderer.material = normalMaterial;
    }
}

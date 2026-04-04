using UnityEngine;

/// <summary>
/// Spawns building visuals for districts.
/// Currently creates colored box placeholders for MVP.
/// Later will load FBX models dynamically from Assets/3D-Models/.
/// </summary>
public class BuildingSpawner : MonoBehaviour
{
    [SerializeField] private Vector3 boxSize = new Vector3(5f, 3f, 5f);
    private GameObject districtPrefab;

    public void Initialize()
    {
        // Create or load prefab for district visual
        CreateDistrictPrefab();
    }

    private void CreateDistrictPrefab()
    {
        districtPrefab = new GameObject("DistrictBoxPlaceholder");
        districtPrefab.AddComponent<MeshFilter>().mesh = CreateBoxMesh();
        districtPrefab.AddComponent<MeshRenderer>();
        districtPrefab.AddComponent<BoxCollider>();
        districtPrefab.AddComponent<DistrictVisual>();

        // Set to not active; instances will be created as needed
        districtPrefab.SetActive(false);
    }

    public DistrictVisual SpawnDistrictVisual(District district)
    {
        GameObject districtGO = Instantiate(districtPrefab, district.WorldPosition, Quaternion.identity);
        districtGO.name = $"District_{district.Name}";
        districtGO.SetActive(true);

        var visual = districtGO.GetComponent<DistrictVisual>();
        visual.Initialize(district);

        return visual;
    }

    private Mesh CreateBoxMesh()
    {
        Mesh mesh = new Mesh();

        // Define vertices
        Vector3[] vertices = new Vector3[]
        {
            new Vector3(-boxSize.x/2, 0, -boxSize.z/2),
            new Vector3(boxSize.x/2, 0, -boxSize.z/2),
            new Vector3(boxSize.x/2, boxSize.y, -boxSize.z/2),
            new Vector3(-boxSize.x/2, boxSize.y, -boxSize.z/2),

            new Vector3(-boxSize.x/2, 0, boxSize.z/2),
            new Vector3(boxSize.x/2, 0, boxSize.z/2),
            new Vector3(boxSize.x/2, boxSize.y, boxSize.z/2),
            new Vector3(-boxSize.x/2, boxSize.y, boxSize.z/2),
        };

        // Define triangles
        int[] triangles = new int[]
        {
            0, 2, 1,
            0, 3, 2,
            4, 5, 6,
            4, 6, 7,
            0, 1, 5,
            0, 5, 4,
            2, 3, 7,
            2, 7, 6,
            0, 4, 7,
            0, 7, 3,
            1, 2, 6,
            1, 6, 5
        };

        mesh.vertices = vertices;
        mesh.triangles = triangles;
        mesh.RecalculateNormals();

        return mesh;
    }
}

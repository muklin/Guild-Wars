using UnityEngine;
using System.Collections.Generic;
using System.Linq;

/// <summary>
/// Generates Voronoi district regions within the city polygon.
/// Uses VoronoiUtils.ComputeVoronoiCells for clean single-pass generation.
/// Stores results in GameStateManager.Instance.CityDistrictData.
/// Also outputs CityEdgeData so StreetVoronoiGenerator can build street networks.
/// </summary>
public class CityVoronoiGenerator : MonoBehaviour
{
    private Dictionary<int, GameObject> districtMeshObjects = new();
    private Dictionary<int, Material>   districtMaterials   = new();

    private const float DistrictY    = 0.07f;
    private const float EdgeThickness = 0.5f;
    private const float EdgeY         = 0.09f;

    // ══════════════════════════════════════════════════════════════════
    // Main entry point
    // ══════════════════════════════════════════════════════════════════

    /// <summary>
    /// Generate city districts and return the inter-district edge data.
    /// </summary>
    public List<CityEdgeData> Generate(List<Vector3> cityPolygon, int districtCount = 6)
    {
        if (cityPolygon == null || cityPolygon.Count < 3)
        {
            Debug.LogError("[CityVoronoiGenerator] Invalid city polygon");
            return new List<CityEdgeData>();
        }

        // Convert to 2-D (XZ plane)
        var poly2d = cityPolygon.Select(v => new Vector2(v.x, v.z)).ToList();

        // Generate seeds inside the polygon using rejection sampling
        var seeds = GenerateSeedsInPolygon(poly2d, districtCount);
        if (seeds.Count < 3)
        {
            seeds = FallbackSeeds(poly2d, districtCount);
            Debug.LogWarning($"[CityVoronoiGenerator] Fell back to {seeds.Count} synthetic seeds");
        }

        var cells = VoronoiUtils.ComputeVoronoiCells(seeds, poly2d);
        Debug.Log($"[CityVoronoiGenerator] Generated {cells.Count} district cells");

        int districtId = 0;
        foreach (var cell in cells)
        {
            var boundary3d = cell.Polygon.Select(v => new Vector3(v.x, 0f, v.y)).ToList();
            var center     = new Vector3(cell.SeedPoint.x, 0f, cell.SeedPoint.y);

            var district = new CityDistrict(districtId, center) { Boundary = boundary3d };
            GameStateManager.Instance.CityDistrictData.AddDistrict(district);
            CreateDistrictMesh(district);
            districtId++;
        }

        return BuildCityEdges(cells);
    }

    // ══════════════════════════════════════════════════════════════════
    // Public visual methods
    // ══════════════════════════════════════════════════════════════════

    public void HighlightDistrict(int id)
    {
        if (!districtMaterials.TryGetValue(id, out var mat)) return;
        var c = mat.color;
        mat.color = new Color(Mathf.Min(c.r*1.1f,1f), Mathf.Min(c.g*1.1f,1f), Mathf.Min(c.b*1.1f,1f), c.a);
    }

    public void ClearHighlight(int id)
    {
        var d = GameStateManager.Instance.CityDistrictData.GetDistrict(id);
        if (d == null || !districtMaterials.TryGetValue(id, out var mat)) return;
        mat.color = DistrictColors.For(d.Class);
    }

    public void SetDistrictClass(int id, DistrictClass cls)
    {
        var d = GameStateManager.Instance.CityDistrictData.GetDistrict(id);
        if (d == null) return;
        d.Class = cls;
        if (districtMaterials.TryGetValue(id, out var mat)) mat.color = DistrictColors.For(cls);
    }

    public CityDistrict GetDistrictAtWorldPos(Vector3 worldPos)
    {
        var all = GameStateManager.Instance.CityDistrictData.GetAllDistricts();
        return all.OrderBy(d => Vector3.Distance(d.CenterPosition, worldPos)).FirstOrDefault();
    }

    // ══════════════════════════════════════════════════════════════════
    // Inter-district edge data (for StreetVoronoiGenerator)
    // ══════════════════════════════════════════════════════════════════

    /// <summary>
    /// Build CityEdgeData for every pair of adjacent districts.
    /// Shared boundary is detected by finding shared / near-coincident polygon segments.
    /// </summary>
    private List<CityEdgeData> BuildCityEdges(List<VoronoiUtils.VoronoiCell> cells)
    {
        var result = new List<CityEdgeData>();

        // For each pair of adjacent cells, find their shared boundary segment
        for (int i = 0; i < cells.Count; i++)
        {
            for (int j = i + 1; j < cells.Count; j++)
            {
                var shared = FindSharedSegments(cells[i].Polygon, cells[j].Polygon);
                if (shared.Count < 2) continue;

                result.Add(new CityEdgeData
                {
                    DistrictA    = i,
                    DistrictB    = j,
                    AssignedType = "Mud",   // default; UI assigns actual type
                    Points       = shared
                });
            }
        }

        return result;
    }

    private List<Vector2> FindSharedSegments(List<Vector2> polyA, List<Vector2> polyB)
    {
        const float tol = 0.05f;
        var shared = new List<Vector2>();

        foreach (var va in polyA)
        {
            bool near = polyB.Any(vb => (va - vb).sqrMagnitude < tol * tol);
            if (near && !shared.Any(s => (s - va).sqrMagnitude < tol * tol))
                shared.Add(va);
        }

        // Sort along the line connecting first and last shared point
        if (shared.Count >= 2)
        {
            var dir = (shared[shared.Count-1] - shared[0]);
            shared.Sort((a, b) => Vector2.Dot(a - shared[0], dir).CompareTo(Vector2.Dot(b - shared[0], dir)));
        }
        return shared;
    }

    // ══════════════════════════════════════════════════════════════════
    // Seed generation
    // ══════════════════════════════════════════════════════════════════

    private List<Vector2> GenerateSeedsInPolygon(List<Vector2> polygon, int count)
    {
        float minX = polygon.Min(v => v.x), maxX = polygon.Max(v => v.x);
        float minY = polygon.Min(v => v.y), maxY = polygon.Max(v => v.y);
        var seeds = new List<Vector2>(count);

        for (int attempt = 0; attempt < count * 20 && seeds.Count < count; attempt++)
        {
            float x = UnityEngine.Random.Range(minX, maxX);
            float y = UnityEngine.Random.Range(minY, maxY);
            if (VoronoiUtils.PointInPolygon(x, y, polygon))
                seeds.Add(new Vector2(x, y));
        }
        return seeds;
    }

    private List<Vector2> FallbackSeeds(List<Vector2> polygon, int count)
    {
        float cx = polygon.Average(v => v.x), cy = polygon.Average(v => v.y);
        var seeds = new List<Vector2>(count);
        for (int i = 0; i < count; i++)
        {
            float ang = i / (float)count * Mathf.PI * 2f;
            float r   = 5f + i % 2;
            seeds.Add(new Vector2(cx + Mathf.Cos(ang)*r, cy + Mathf.Sin(ang)*r));
        }
        return seeds;
    }

    // ══════════════════════════════════════════════════════════════════
    // Mesh building
    // ══════════════════════════════════════════════════════════════════

    private void CreateDistrictMesh(CityDistrict district)
    {
        var go = new GameObject($"District_{district.Id}");
        go.transform.SetParent(transform);
        go.layer = LayerMask.NameToLayer("Buildings");

        var mf = go.AddComponent<MeshFilter>();
        mf.mesh = BuildPolygonMesh(district.Boundary);

        var mr     = go.AddComponent<MeshRenderer>();
        var shader = Shader.Find("Transparent/VertexLit") ?? Shader.Find("Transparent/Diffuse") ?? Shader.Find("Standard");
        var mat    = new Material(shader) { color = DistrictColors.For(district.Class) };
        mr.material = mat;

        go.AddComponent<MeshCollider>().convex = false;

        districtMeshObjects[district.Id] = go;
        districtMaterials[district.Id]   = mat;
    }

    private Mesh BuildPolygonMesh(List<Vector3> polygon)
    {
        var verts = polygon.Select(v => new Vector3(v.x, DistrictY, v.z)).ToArray();
        int n = verts.Length;
        var tris = new int[(n-2)*3];
        int t = 0;
        for (int i = 1; i <= n-2; i++) { tris[t++]=0; tris[t++]=i+1; tris[t++]=i; }
        var mesh = new Mesh { vertices = verts, triangles = tris };
        mesh.RecalculateNormals();
        return mesh;
    }
}

/// <summary>Static color mapping for district classes.</summary>
public static class DistrictColors
{
    private static readonly Dictionary<DistrictClass, Color> ColorMap = new()
    {
        { DistrictClass.Neutral,       new Color(0.65f, 0.65f, 0.65f) },
        { DistrictClass.Commerce,      new Color(0.90f, 0.75f, 0.20f) },
        { DistrictClass.Military,      new Color(0.60f, 0.20f, 0.20f) },
        { DistrictClass.Magical,       new Color(0.50f, 0.20f, 0.80f) },
        { DistrictClass.Religious,     new Color(0.85f, 0.85f, 0.40f) },
        { DistrictClass.Noble,         new Color(0.90f, 0.90f, 0.60f) },
        { DistrictClass.Slums,         new Color(0.40f, 0.35f, 0.30f) },
        { DistrictClass.Entertainment, new Color(0.90f, 0.40f, 0.70f) },
        { DistrictClass.Industrial,    new Color(0.50f, 0.45f, 0.30f) },
        { DistrictClass.Agricultural,  new Color(0.45f, 0.75f, 0.30f) },
    };

    public static Color For(DistrictClass cls)
        => ColorMap.TryGetValue(cls, out var c) ? c : Color.white;

    public static Color Unassigned => new Color(0.75f, 0.75f, 0.75f);
}

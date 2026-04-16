using UnityEngine;
using System.Collections.Generic;
using System.Linq;
using DelaunayVoronoi;

/// <summary>
/// Generates Voronoi district regions within the city polygon.
/// Subdivides the city into ~6 districts, all clipped to the city polygon boundary.
/// Stores results in GameStateManager.Instance.CityDistrictData.
/// </summary>
public class CityVoronoiGenerator : MonoBehaviour {
    private Dictionary<int, GameObject> districtMeshObjects = new();
    private Dictionary<int, Material> districtMaterials = new();
    private const float DistrictY = 0.07f; // Above terrain (0.05f), visible on top
    private const float EdgeThickness = 0.5f;

    /// <summary>
    /// Generate city districts by subdividing the city polygon with Voronoi.
    /// Seeds are randomly placed within the polygon and clipped to the boundary.
    /// </summary>
    public void Generate(List<Vector3> cityPolygon, int districtCount = 6) {
        if (cityPolygon == null || cityPolygon.Count < 3) {
            Debug.LogError("[CityVoronoiGenerator] Invalid city polygon");
            return;
        }

        Debug.Log($"[CityVoronoiGenerator] Generating {districtCount} districts from city polygon with {cityPolygon.Count} vertices");

        // 1. Generate seeds within the city polygon using rejection sampling
        var seeds = GenerateSeedsWithinPolygon(cityPolygon, districtCount);
        if (seeds.Count < 3) {
            Debug.LogWarning($"[CityVoronoiGenerator] Only generated {seeds.Count} seeds, expected {districtCount}. Using fallback.");
            seeds = GenerateFallbackSeeds(cityPolygon, districtCount);
        }

        Debug.Log($"[CityVoronoiGenerator] Generated {seeds.Count} seeds");

        // 2. Convert seeds to Delaunay points
        var points = new List<Point>();
        var seedPoints = new List<Vector3>(seeds);
        for (int i = 0; i < seedPoints.Count; i++) {
            points.Add(new Point(seedPoints[i].x, seedPoints[i].z));
        }

        // Add super-triangle corners far outside the city bounds
        var bounds = ComputeAABB(cityPolygon);
        float margin = 100f;
        points.Add(new Point(bounds.min.x - margin, bounds.min.z - margin));
        points.Add(new Point(bounds.max.x + margin, bounds.min.z - margin));
        points.Add(new Point(bounds.min.x - margin, bounds.max.z + margin));
        points.Add(new Point(bounds.max.x + margin, bounds.max.z + margin));

        // 3. Run Delaunay triangulation
        var triangulator = new DelaunayTriangulator(points);
        triangulator.BowyerWatson();
        Debug.Log($"[CityVoronoiGenerator] Delaunay triangulation complete: {triangulator.Triangulation.Count} triangles");

        // 4. For each seed, collect triangles and build Voronoi cell
        int districtId = 0;
        for (int i = 0; i < seedPoints.Count; i++) {
            var seedPoint = seedPoints[i];
            var delaunayPoint = points[i];

            // Find triangles containing this seed point
            var trianglesWithSeed = triangulator.Triangulation
                .Where(t => t.Vertices.Contains(delaunayPoint))
                .ToList();

            if (trianglesWithSeed.Count == 0)
                continue;

            // Collect circumcenters
            var circumcenters = trianglesWithSeed
                .Select(t => new Vector3((float)t.Circumcenter.X, 0, (float)t.Circumcenter.Y))
                .ToList();

            // Sort by angle around seed
            var sortedVertices = SortByAngle(seedPoint, circumcenters);

            // Clip to city polygon
            var clippedVertices = SutherlandHodgmanClipConvex(sortedVertices, cityPolygon);

            if (clippedVertices.Count >= 3) {
                // Create district
                var district = new CityDistrict(districtId, seedPoint) {
                    Boundary = clippedVertices
                };
                GameStateManager.Instance.CityDistrictData.AddDistrict(district);

                // Create mesh GameObject
                CreateDistrictMesh(district);
                districtId++;

                Debug.Log($"[CityVoronoiGenerator] District {district.Id} created with {clippedVertices.Count} boundary vertices");
            }
        }

        Debug.Log($"[CityVoronoiGenerator] Generated {districtId} city districts");
    }

    /// <summary>Highlight a district by brightening its material.</summary>
    public void HighlightDistrict(int districtId) {
        if (districtMaterials.TryGetValue(districtId, out var material)) {
            var currentColor = material.color;
            material.color = new Color(
                Mathf.Min(currentColor.r * 1.1f, 1f),
                Mathf.Min(currentColor.g * 1.1f, 1f),
                Mathf.Min(currentColor.b * 1.1f, 1f),
                currentColor.a
            );
        }
    }

    /// <summary>Clear highlight on a district by restoring its base color.</summary>
    public void ClearHighlight(int districtId) {
        var district = GameStateManager.Instance.CityDistrictData.GetDistrict(districtId);
        if (district == null)
            return;

        if (districtMaterials.TryGetValue(districtId, out var material)) {
            material.color = DistrictColors.For(district.Class);
        }
    }

    /// <summary>Assign a district class and update its visual color.</summary>
    public void SetDistrictClass(int districtId, DistrictClass cls) {
        var district = GameStateManager.Instance.CityDistrictData.GetDistrict(districtId);
        if (district == null)
            return;

        district.Class = cls;

        if (districtMaterials.TryGetValue(districtId, out var material)) {
            material.color = DistrictColors.For(cls);
        }
    }

    /// <summary>Get the district at a world position (nearest-seed lookup).</summary>
    public CityDistrict GetDistrictAtWorldPos(Vector3 worldPos) {
        var allDistricts = GameStateManager.Instance.CityDistrictData.GetAllDistricts();
        CityDistrict closest = null;
        float closestDist = float.MaxValue;

        foreach (var district in allDistricts) {
            float dist = Vector3.Distance(district.CenterPosition, worldPos);
            if (dist < closestDist) {
                closestDist = dist;
                closest = district;
            }
        }

        return closest;
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Private helpers
    // ═══════════════════════════════════════════════════════════════════════

    private List<Vector3> GenerateSeedsWithinPolygon(List<Vector3> polygon, int targetCount) {
        var seeds = new List<Vector3>();
        var bounds = ComputeAABB(polygon);
        var random = new System.Random();

        // Try up to targetCount * 20 candidates
        for (int i = 0; i < targetCount * 20 && seeds.Count < targetCount; i++) {
            float x = (float)random.NextDouble() * (bounds.max.x - bounds.min.x) + bounds.min.x;
            float z = (float)random.NextDouble() * (bounds.max.z - bounds.min.z) + bounds.min.z;
            var point = new Vector3(x, 0, z);

            if (IsPointInPolygon(point, polygon)) {
                seeds.Add(point);
            }
        }

        return seeds;
    }

    private List<Vector3> GenerateFallbackSeeds(List<Vector3> polygon, int count) {
        // Generate points evenly spaced on a shrunk version of the polygon
        var seeds = new List<Vector3>();
        var center = polygon.Aggregate(Vector3.zero, (a, b) => a + b) / polygon.Count;

        for (int i = 0; i < count; i++) {
            float angle = (i / (float)count) * Mathf.PI * 2f;
            float radius = 5f + i % 2; // slight variation in radius
            var seed = center + new Vector3(Mathf.Cos(angle), 0, Mathf.Sin(angle)) * radius;
            seeds.Add(seed);
        }

        return seeds;
    }

    private (Vector3 min, Vector3 max) ComputeAABB(List<Vector3> polygon) {
        Vector3 min = polygon[0];
        Vector3 max = polygon[0];

        foreach (var v in polygon) {
            min = Vector3.Min(min, v);
            max = Vector3.Max(max, v);
        }

        return (min, max);
    }

    private bool IsPointInPolygon(Vector3 point, List<Vector3> polygon) {
        // Ray casting algorithm in XZ plane
        // Cast a ray in +X direction and count edge crossings
        int windingNumber = 0;

        for (int i = 0; i < polygon.Count; i++) {
            var p1 = polygon[i];
            var p2 = polygon[(i + 1) % polygon.Count];

            // Check if ray crosses this edge
            if ((p1.z <= point.z && p2.z > point.z) || (p2.z <= point.z && p1.z > point.z)) {
                // Compute x-intersection
                float xIntersection = p1.x + (point.z - p1.z) / (p2.z - p1.z) * (p2.x - p1.x);
                if (point.x < xIntersection) {
                    windingNumber += (p2.z > p1.z) ? 1 : -1;
                }
            }
        }

        return windingNumber != 0;
    }

    private List<Vector3> SutherlandHodgmanClipConvex(List<Vector3> subject, List<Vector3> clipPolygon) {
        var output = new List<Vector3>(subject);

        // Clip against each edge of the clip polygon
        for (int i = 0; i < clipPolygon.Count; i++) {
            if (output.Count == 0)
                break;

            var A = clipPolygon[i];
            var B = clipPolygon[(i + 1) % clipPolygon.Count];
            var input = output;
            output = new List<Vector3>();

            for (int j = 0; j < input.Count; j++) {
                var current = input[j];
                var previous = input[(j + input.Count - 1) % input.Count];

                bool currentInside = IsInsideEdge(current, A, B);
                bool previousInside = IsInsideEdge(previous, A, B);

                if (currentInside) {
                    if (!previousInside) {
                        // Entering: add intersection
                        var intersection = LineIntersectEdge(previous, current, A, B);
                        if (intersection.HasValue)
                            output.Add(intersection.Value);
                    }
                    output.Add(current);
                } else if (previousInside) {
                    // Leaving: add intersection
                    var intersection = LineIntersectEdge(previous, current, A, B);
                    if (intersection.HasValue)
                        output.Add(intersection.Value);
                }
            }
        }

        return output;
    }

    private bool IsInsideEdge(Vector3 p, Vector3 edgeA, Vector3 edgeB) {
        // Cross product test: (B-A) × (P-A).y >= 0 means P is on the left of A→B
        float cross = (edgeB.x - edgeA.x) * (p.z - edgeA.z) - (edgeB.z - edgeA.z) * (p.x - edgeA.x);
        return cross >= 0;
    }

    private Vector3? LineIntersectEdge(Vector3 p1, Vector3 p2, Vector3 edgeA, Vector3 edgeB) {
        // Find intersection of line segment p1→p2 with infinite line through edgeA→edgeB
        // Using parametric approach: p1 + t*(p2-p1) = edgeA + s*(edgeB-edgeA)
        float denom = (edgeB.x - edgeA.x) * (p2.z - p1.z) - (edgeB.z - edgeA.z) * (p2.x - p1.x);
        if (Mathf.Abs(denom) < 0.0001f)
            return null; // Lines are parallel

        float numer = (edgeA.x - p1.x) * (p2.z - p1.z) - (edgeA.z - p1.z) * (p2.x - p1.x);
        float t = numer / denom;

        // Check if intersection is within the segment [p1, p2]
        if (t < -0.0001f || t > 1.0001f)
            return null;

        return p1 + (p2 - p1) * t;
    }

    private List<Vector3> SortByAngle(Vector3 center, List<Vector3> points) {
        var sorted = points
            .OrderBy(p => Mathf.Atan2(p.z - center.z, p.x - center.x))
            .ToList();
        return sorted;
    }

    private void CreateDistrictMesh(CityDistrict district) {
        var go = new GameObject($"District_{district.Id}");
        go.transform.SetParent(transform);
        go.layer = LayerMask.NameToLayer("Buildings");

        var meshFilter = go.AddComponent<MeshFilter>();
        meshFilter.mesh = BuildPolygonMesh(district.Boundary);

        var meshRenderer = go.AddComponent<MeshRenderer>();
        var shader = Shader.Find("Transparent/VertexLit");
        if (shader == null)
            shader = Shader.Find("Transparent/Diffuse");
        if (shader == null)
            shader = Shader.Find("Standard");

        var material = new Material(shader);
        material.color = DistrictColors.For(district.Class);
        meshRenderer.material = material;

        var meshCollider = go.AddComponent<MeshCollider>();
        meshCollider.convex = false;

        districtMeshObjects[district.Id] = go;
        districtMaterials[district.Id] = material;
    }

    private Mesh BuildPolygonMesh(List<Vector3> polygon) {
        // Force Y = DistrictY on all verts, fan triangulation from vertex 0
        var verts = polygon
            .Select(v => new Vector3(v.x, DistrictY, v.z))
            .ToArray();

        int n = verts.Length;
        int[] tris = new int[(n - 2) * 3];
        int t = 0;

        // Fan triangulation with clockwise winding for Y-up
        for (int i = 1; i <= n - 2; i++) {
            tris[t++] = 0;
            tris[t++] = i + 1;
            tris[t++] = i;
        }

        var mesh = new Mesh();
        mesh.vertices = verts;
        mesh.triangles = tris;
        mesh.RecalculateNormals();

        return mesh;
    }
}

/// <summary>Static color mapping for district classes.</summary>
public static class DistrictColors {
    private static readonly Dictionary<DistrictClass, Color> ColorMap = new() {
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

    public static Color For(DistrictClass cls) {
        return ColorMap.TryGetValue(cls, out var color) ? color : Color.white;
    }

    public static Color Unassigned => new Color(0.75f, 0.75f, 0.75f);
}

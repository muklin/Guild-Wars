using UnityEngine;
using System.Collections.Generic;
using System.Linq;
using DelaunayVoronoi;

/// <summary>
/// Generates and renders Voronoi regions covering the 50x50 world.
/// Each region is a flat colored polygon that can be assigned a terrain type.
/// </summary>
public class VoronoiWorldGenerator : MonoBehaviour
{
    [SerializeField] public int regionCount = 15;
    public float worldSize = 50f;
    private List<VoronoiRegion> regions = new();
    private List<EdgeFeature> edgeFeatures = new();
    private List<VoronoiEdge> edges = new();
    public IReadOnlyList<VoronoiRegion> Regions => regions;
    public IReadOnlyList<EdgeFeature> EdgeFeatures => edgeFeatures;
    public IReadOnlyList<VoronoiEdge> Edges => edges;

    private const float BorderMargin = 0f; // Allow seeds to reach edges for full coverage
    private const float PolygonY = 0.05f;
    private const float EdgeThickness = 0.3f;

    public class VoronoiRegion
    {
        public int Id;
        public Vector3 SeedPoint;
        public List<Vector3> Polygon;
        public TerrainType? AssignedType;
        public GameObject MeshObject;
        public Material Material;
        public int GridX, GridZ;
    }

    public void Generate()
    {
        Debug.Log($"Generating {regionCount} Voronoi regions...");

        // Create seed points (avoid borders)
        var points = new List<Point>();
        var seedPoints = new List<Vector3>();
        var random = new System.Random();

        for (int i = 0; i < regionCount; i++)
        {
            float x = (float)(random.NextDouble() * (worldSize - 2 * BorderMargin) + BorderMargin);
            float z = (float)(random.NextDouble() * (worldSize - 2 * BorderMargin) + BorderMargin);
            seedPoints.Add(new Vector3(x, 0, z));
            points.Add(new Point(x, z));
        }

        // Record super-triangle point indices before adding them
        int superTriangleStartIndex = points.Count;
        points.Add(new Point(-100, -100));
        points.Add(new Point(worldSize + 100, -100));
        points.Add(new Point(-100, worldSize + 100));
        points.Add(new Point(worldSize + 100, worldSize + 100));

        // Run Delaunay
        var triangulator = new DelaunayTriangulator(points);
        triangulator.BowyerWatson();

        // Build Voronoi cells
        for (int i = 0; i < seedPoints.Count; i++)
        {
            var seedPoint = seedPoints[i];
            var delaunayPoint = points[i];

            // Find all triangles containing this seed, excluding super-triangle triangles
            var trianglesWithSeed = triangulator.Triangulation
                .Where(t => t.Vertices.Contains(delaunayPoint) &&
                           !IsSupertriangle(t, superTriangleStartIndex))
                .ToList();

            if (trianglesWithSeed.Count == 0) continue;

            // Collect circumcenters
            var circumcenters = trianglesWithSeed
                .Select(t => new Vector3((float)t.Circumcenter.X, 0, (float)t.Circumcenter.Y))
                .ToList();

            // Sort by angle around seed point
            var sortedVertices = SortByAngle(seedPoint, circumcenters);

            // Clamp to world bounds
            var clampedVertices = ClampToBounds(sortedVertices);

            // Re-sort by angle after clamping to restore ordering
            if (clampedVertices.Count >= 3)
                clampedVertices = SortByAngle(seedPoint, clampedVertices);

            if (clampedVertices.Count >= 3)
            {
                var region = new VoronoiRegion
                {
                    Id = i,
                    SeedPoint = seedPoint,
                    Polygon = clampedVertices,
                    AssignedType = null,
                    GridX = Mathf.RoundToInt(seedPoint.x / 10f),
                    GridZ = Mathf.RoundToInt(seedPoint.z / 10f)
                };

                // Create mesh and GameObject
                region.MeshObject = CreateRegionMesh(region);
                region.Material = region.MeshObject.GetComponent<MeshRenderer>().material;

                regions.Add(region);
            }
        }

        Debug.Log($"Generated {regions.Count} Voronoi regions");

        // Identify and mark the central city region
        IdentifyCityRegion();

        // Generate edges between adjacent regions
        GenerateEdges();
    }

    private void IdentifyCityRegion()
    {
        // Find regions that don't touch the map boundary
        var centralRegions = regions
            .Where(r => !TouchesBoundary(r))
            .ToList();

        if (centralRegions.Count == 0)
        {
            Debug.LogWarning("No central regions found; selecting largest region as city");
            // Fallback: use largest region regardless
            var largestRegion = regions.OrderByDescending(r => r.Polygon.Count).First();
            SetCityRegion(largestRegion);
            return;
        }

        // Select the largest central region
        var cityRegion = centralRegions.OrderByDescending(r => r.Polygon.Count).First();
        SetCityRegion(cityRegion);
    }

    private bool TouchesBoundary(VoronoiRegion region)
    {
        const float margin = 0.5f;
        return region.Polygon.Any(v =>
            v.x < margin || v.x > (worldSize - margin) ||
            v.z < margin || v.z > (worldSize - margin)
        );
    }

    private void SetCityRegion(VoronoiRegion region)
    {
        region.AssignedType = TerrainType.City;
        region.Material.color = TerrainColors.For(TerrainType.City);
        Debug.Log($"City region identified: Region {region.Id} at seed {region.SeedPoint} ({region.Polygon.Count} vertices)");
    }

    private bool IsSupertriangle(DelaunayVoronoi.Triangle triangle, int superTriangleStartIndex)
    {
        // A triangle is part of the super-triangle if any of its vertices
        // is a super-triangle point (far outside world bounds)
        const float threshold = 60f; // Super-triangle points are at ±100
        return triangle.Vertices.Any(v =>
            v.X < -threshold || v.X > (worldSize + threshold) ||
            v.Y < -threshold || v.Y > (worldSize + threshold)
        );
    }

    private List<Vector3> SortByAngle(Vector3 center, List<Vector3> points)
    {
        var sorted = points
            .OrderBy(p => Mathf.Atan2(p.z - center.z, p.x - center.x))
            .ToList();
        return sorted;
    }

    private List<Vector3> ClampToBounds(List<Vector3> vertices)
    {
        var clamped = vertices
            .Select(v => new Vector3(
                Mathf.Clamp(v.x, 0, worldSize),
                v.y,
                Mathf.Clamp(v.z, 0, worldSize)
            ))
            .ToList();

        // Remove duplicate vertices that result from clamping
        var deduplicated = new List<Vector3>();
        const float tolerance = 0.01f;

        foreach (var vertex in clamped)
        {
            // Check if this vertex is already in the list (within tolerance)
            bool isDuplicate = deduplicated.Any(v =>
                Mathf.Abs(v.x - vertex.x) < tolerance &&
                Mathf.Abs(v.y - vertex.y) < tolerance &&
                Mathf.Abs(v.z - vertex.z) < tolerance
            );

            if (!isDuplicate)
                deduplicated.Add(vertex);
        }

        return deduplicated;
    }

    private GameObject CreateRegionMesh(VoronoiRegion region)
    {
        var go = new GameObject($"VoronoiRegion_{region.Id}");
        go.transform.SetParent(transform);
        go.layer = LayerMask.NameToLayer("Buildings"); // Reuse the Buildings layer

        var meshFilter = go.AddComponent<MeshFilter>();
        meshFilter.mesh = BuildPolygonMesh(region.Polygon);

        var meshRenderer = go.AddComponent<MeshRenderer>();
        var material = new Material(Shader.Find("Unlit/Color"));
        material.color = TerrainColors.Unassigned;
        meshRenderer.material = material;

        var meshCollider = go.AddComponent<MeshCollider>();
        meshCollider.convex = false;

        return go;
    }

    private Mesh BuildPolygonMesh(List<Vector3> polygon)
    {
        // Force Y = 0.05 on all verts, then fan triangulation from vertex 0
        var verts = polygon
            .Select(v => new Vector3(v.x, PolygonY, v.z))
            .ToArray();

        int n = verts.Length;
        int[] tris = new int[(n - 2) * 3];
        int t = 0;

        // Fan triangulation with clockwise winding for Y-up
        for (int i = 1; i <= n - 2; i++)
        {
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

    public void SetRegionTerrain(int regionId, TerrainType type)
    {
        if (regionId < 0 || regionId >= regions.Count) return;

        var region = regions[regionId];

        // Enforce boundary constraint: only edge regions can be Sea or Mountain
        if ((type == TerrainType.Sea || type == TerrainType.Mountains) && !TouchesBoundary(region))
        {
            Debug.LogWarning($"Cannot assign {type} to interior region {regionId}. Only boundary regions can be Sea or Mountains.");
            return;
        }

        region.AssignedType = type;
        region.Material.color = TerrainColors.For(type);
    }

    public VoronoiRegion GetRegionAtWorldPos(Vector3 pos)
    {
        // Simple nearest-seed lookup
        float closestDist = float.MaxValue;
        VoronoiRegion closest = null;

        foreach (var region in regions)
        {
            float dist = Vector3.Distance(pos, region.SeedPoint);
            if (dist < closestDist)
            {
                closestDist = dist;
                closest = region;
            }
        }

        return closest;
    }

    public void HighlightRegion(int regionId)
    {
        if (regionId < 0 || regionId >= regions.Count) return;
        regions[regionId].Material.color = Color.white;
    }

    public void ClearHighlight(int regionId)
    {
        if (regionId < 0 || regionId >= regions.Count) return;

        var region = regions[regionId];
        region.Material.color = region.AssignedType.HasValue
            ? TerrainColors.For(region.AssignedType.Value)
            : TerrainColors.Unassigned;
    }

    /// <summary>Adds an edge feature (cliff/river) between regions.</summary>
    public bool AddEdgeFeature(List<(int regionA, int regionB)> edges, EdgeFeature.EdgeFeatureType type, string description)
    {
        var feature = new EdgeFeature(edgeFeatures.Count, type, edges, description);

        if (!feature.IsValid())
        {
            Debug.LogWarning($"Invalid {type} feature: {description}");
            return false;
        }

        edgeFeatures.Add(feature);
        Debug.Log($"Added {type} feature: {description}");
        return true;
    }

    /// <summary>Gets all edge features of a specific type.</summary>
    public List<EdgeFeature> GetEdgeFeaturesByType(EdgeFeature.EdgeFeatureType type)
    {
        var result = new List<EdgeFeature>();
        foreach (var feature in edgeFeatures)
        {
            if (feature.Type == type)
                result.Add(feature);
        }
        return result;
    }

    /// <summary>Gets edge features that connect two specific regions.</summary>
    public EdgeFeature GetEdgeFeatureBetween(int regionA, int regionB)
    {
        foreach (var feature in edgeFeatures)
        {
            foreach (var (a, b) in feature.Edges)
            {
                if ((a == regionA && b == regionB) || (a == regionB && b == regionA))
                    return feature;
            }
        }
        return null;
    }

    private void GenerateEdges()
    {
        // Find adjacent region pairs and create edge objects
        var adjacencySet = new HashSet<(int, int)>();

        for (int i = 0; i < regions.Count; i++)
        {
            for (int j = i + 1; j < regions.Count; j++)
            {
                if (AreRegionsAdjacent(regions[i], regions[j]))
                {
                    var key = (i < j) ? (i, j) : (j, i);
                    if (!adjacencySet.Contains(key))
                    {
                        adjacencySet.Add(key);
                        CreateEdgeObject(i, j);
                    }
                }
            }
        }

        Debug.Log($"Generated {edges.Count} region edges");
    }

    private bool AreRegionsAdjacent(VoronoiRegion a, VoronoiRegion b)
    {
        // Simple check: if regions' polygons have vertices within close proximity, they're adjacent
        const float proximity = 1.5f;

        foreach (var vertexA in a.Polygon)
        {
            foreach (var vertexB in b.Polygon)
            {
                if (Vector3.Distance(vertexA, vertexB) < proximity)
                    return true;
            }
        }

        return false;
    }

    private void CreateEdgeObject(int regionA, int regionB)
    {
        // Find the shared edge line between two regions
        var edgePoints = FindSharedEdge(regions[regionA], regions[regionB]);
        if (edgePoints.Count < 2) return;

        Vector3 start = edgePoints[0];
        Vector3 end = edgePoints[edgePoints.Count - 1];

        // Create a thin quad along the edge
        var edgeGO = new GameObject($"Edge_{regionA}_{regionB}");
        edgeGO.transform.SetParent(transform);
        edgeGO.layer = LayerMask.NameToLayer("Buildings");

        // Create mesh
        var meshFilter = edgeGO.AddComponent<MeshFilter>();
        meshFilter.mesh = BuildEdgeMesh(start, end);

        // Add renderer
        var meshRenderer = edgeGO.AddComponent<MeshRenderer>();
        var material = new Material(Shader.Find("Unlit/Color"));
        material.color = new Color(1f, 1f, 1f, 0.3f);
        meshRenderer.material = material;

        // Add collider for interaction
        var meshCollider = edgeGO.AddComponent<MeshCollider>();
        meshCollider.convex = false;

        // Add VoronoiEdge component
        var edgeComponent = edgeGO.AddComponent<VoronoiEdge>();
        edgeComponent.Initialize(edges.Count, regionA, regionB, start, end);

        edges.Add(edgeComponent);
    }

    private List<Vector3> FindSharedEdge(VoronoiRegion a, VoronoiRegion b)
    {
        var shared = new List<Vector3>();
        const float threshold = 0.5f;

        foreach (var vertexA in a.Polygon)
        {
            foreach (var vertexB in b.Polygon)
            {
                if (Vector3.Distance(vertexA, vertexB) < threshold)
                {
                    if (!shared.Contains(vertexA))
                        shared.Add(vertexA);
                }
            }
        }

        return shared;
    }

    private Mesh BuildEdgeMesh(Vector3 start, Vector3 end)
    {
        // Create a thin quad perpendicular to the edge
        var mesh = new Mesh();

        Vector3 dir = (end - start).normalized;
        Vector3 perpendicular = new Vector3(-dir.z, 0, dir.x) * (EdgeThickness / 2f);

        var vertices = new[]
        {
            start - perpendicular,
            start + perpendicular,
            end + perpendicular,
            end - perpendicular
        };

        var triangles = new[] { 0, 1, 2, 0, 2, 3 };

        mesh.vertices = vertices;
        mesh.triangles = triangles;
        mesh.RecalculateNormals();

        return mesh;
    }

    public void HighlightEdge(VoronoiEdge edge)
    {
        edge.Highlight();
    }

    public void ClearEdgeHighlight(VoronoiEdge edge)
    {
        edge.ClearHighlight();
    }
}

using UnityEngine;
using System.Collections.Generic;
using System.Linq;
using DelaunayVoronoi;

/// <summary>
/// Generates and renders Voronoi regions covering the 50x50 world.
/// Separates data (stored in GameStateManager.WorldTerrainData) from visualization (GameObjects, materials).
/// </summary>
public class VoronoiWorldGenerator : MonoBehaviour {
    [SerializeField] public int regionCount = 15;
    public float worldSize = 50f;

    // Reference to centralized terrain data (via GameStateManager)
    public TerrainData TerrainData => GameStateManager.Instance?.WorldTerrainData;

    // Visualization details (kept separate from data)
    private Dictionary<int, GameObject> regionMeshObjects = new();
    private Dictionary<int, Material> regionMaterials = new();

    private List<EdgeFeature> edgeFeatures = new();
    private List<VoronoiEdge> edges = new();

    public IReadOnlyList<EdgeFeature> EdgeFeatures => edgeFeatures;
    public IReadOnlyList<VoronoiEdge> Edges => edges;

    private const float BorderMargin = 0f; // Allow seeds to reach edges for full coverage
    private const float PolygonY = 0.05f;
    private const float EdgeThickness = 0.5f;
    private const float EdgeY = 0.1f; // Position edges above regions for visibility

    public void Generate() {
        Debug.Log($"Generating {regionCount} Voronoi regions...");

        if (TerrainData == null) {
            Debug.LogError("[VoronoiWorldGenerator] GameStateManager.WorldTerrainData is null!");
            return;
        }

        TerrainData.WorldSize = worldSize;

        // Create seed points (avoid borders)
        var points = new List<Point>();
        var seedPoints = new List<Vector3>();
        var random = new System.Random();

        for (int i = 0; i < regionCount; i++) {
            float x = (float)(random.NextDouble() * (worldSize - 2 * BorderMargin) + BorderMargin);
            float z = (float)(random.NextDouble() * (worldSize - 2 * BorderMargin) + BorderMargin);
            seedPoints.Add(new Vector3(x, 0, z));
            points.Add(new Point(x, z));
        }

        // Add super-triangle points far outside bounds
        points.Add(new Point(-100, -100));
        points.Add(new Point(worldSize + 100, -100));
        points.Add(new Point(-100, worldSize + 100));
        points.Add(new Point(worldSize + 100, worldSize + 100));

        // Run Delaunay
        var triangulator = new DelaunayTriangulator(points);
        triangulator.BowyerWatson();

        // Build Voronoi cells
        for (int i = 0; i < seedPoints.Count; i++) {
            var seedPoint = seedPoints[i];
            var delaunayPoint = points[i];

            // Find all triangles containing this seed
            var trianglesWithSeed = triangulator.Triangulation
                .Where(t => t.Vertices.Contains(delaunayPoint))
                .ToList();

            if (trianglesWithSeed.Count == 0)
                continue;

            // Collect circumcenters
            var circumcenters = trianglesWithSeed
                .Select(t => new Vector3((float)t.Circumcenter.X, 0, (float)t.Circumcenter.Y))
                .ToList();

            // Sort by angle around seed point
            var sortedVertices = SortByAngle(seedPoint, circumcenters);

            // Clip polygon to world bounds using Sutherland-Hodgman algorithm
            var clippedVertices = SutherlandHodgmanClip(sortedVertices);

            if (clippedVertices.Count >= 3) {
                // Create pure data region (no GameObjects)
                var region = new VoronoiRegion(i, seedPoint,
                    Mathf.RoundToInt(seedPoint.x / 10f),
                    Mathf.RoundToInt(seedPoint.z / 10f))
                {
                    Polygon = clippedVertices,
                    AssignedType = null
                };

                TerrainData.AddRegion(region);

                // Create visualization (separate from data)
                var meshGO = CreateRegionMesh(region);
                regionMeshObjects[region.Id] = meshGO;
                var material = meshGO.GetComponent<MeshRenderer>().material;
                regionMaterials[region.Id] = material;
            }
        }

        //Debug.Log($"Generated {TerrainData.RegionCount} Voronoi regions");

        // Identify and mark the central city region
        IdentifyCityRegion();

        // Generate edges between adjacent regions
        GenerateEdges();
    }

    private void IdentifyCityRegion() {
        var allRegions = TerrainData.GetAllRegions();

        // Find regions that don't touch the map boundary
        var centralRegions = allRegions
            .Where(r => !TouchesBoundary(r))
            .ToList();

        if (centralRegions.Count == 0) {
            Debug.LogWarning("No central regions found; selecting largest region as city");
            // Fallback: use largest region regardless
            var largestRegion = allRegions.OrderByDescending(r => r.Polygon.Count).First();
            SetCityRegion(largestRegion);
            return;
        }

        // Select the largest central region
        var cityRegion = centralRegions.OrderByDescending(r => r.Polygon.Count).First();
        SetCityRegion(cityRegion);
    }

    private bool TouchesBoundary(VoronoiRegion region) {
        const float margin = 0.5f;
        return region.Polygon.Any(v =>
            v.x < margin || v.x > (worldSize - margin) ||
            v.z < margin || v.z > (worldSize - margin)
        );
    }

    private void SetCityRegion(VoronoiRegion region) {
        TerrainData.SetRegionTerrain(region.Id, TerrainType.City);
        if (regionMaterials.TryGetValue(region.Id, out var material))
            material.color = TerrainColors.For(TerrainType.City);
        Debug.Log($"City region identified: Region {region.Id} at seed {region.SeedPoint} ({region.Polygon.Count} vertices)");
    }

    private List<Vector3> SortByAngle(Vector3 center, List<Vector3> points) {
        var sorted = points
            .OrderBy(p => Mathf.Atan2(p.z - center.z, p.x - center.x))
            .ToList();
        return sorted;
    }

    private List<Vector3> SutherlandHodgmanClip(List<Vector3> polygon) {
        if (polygon.Count < 3)
            return polygon;

        // Sutherland-Hodgman polygon clipping against rectangular boundary
        var output = new List<Vector3>(polygon);

        // Clip against each boundary edge (left, right, bottom, top)
        output = ClipAgainstEdge(output, true, 0);           // Left edge (x = 0)
        if (output.Count < 3) return output;
        output = ClipAgainstEdge(output, true, worldSize);   // Right edge (x = worldSize)
        if (output.Count < 3) return output;
        output = ClipAgainstEdge(output, false, 0);          // Bottom edge (z = 0)
        if (output.Count < 3) return output;
        output = ClipAgainstEdge(output, false, worldSize);  // Top edge (z = worldSize)

        return output;
    }

    private List<Vector3> ClipAgainstEdge(List<Vector3> polygon, bool isVerticalEdge, float edgePos) {
        if (polygon.Count == 0)
            return polygon;

        var output = new List<Vector3>();

        for (int i = 0; i < polygon.Count; i++) {
            var current = polygon[i];
            var next = polygon[(i + 1) % polygon.Count];

            bool currentInside = IsInsideEdge(current, isVerticalEdge, edgePos);
            bool nextInside = IsInsideEdge(next, isVerticalEdge, edgePos);

            if (nextInside) {
                if (!currentInside) {
                    // Entering the inside region - add intersection
                    var intersection = LineIntersection(current, next, isVerticalEdge, edgePos);
                    if (intersection.HasValue)
                        output.Add(intersection.Value);
                }
                output.Add(next);
            } else if (currentInside) {
                // Leaving the inside region - add intersection
                var intersection = LineIntersection(current, next, isVerticalEdge, edgePos);
                if (intersection.HasValue)
                    output.Add(intersection.Value);
            }
        }

        return output;
    }

    private bool IsInsideEdge(Vector3 point, bool isVerticalEdge, float edgePos) {
        if (isVerticalEdge) {
            // For vertical edges: left (x=0) inside if x >= 0, right (x=worldSize) inside if x <= worldSize
            return edgePos == 0 ? point.x >= -0.01f : point.x <= worldSize + 0.01f;
        } else {
            // For horizontal edges: bottom (z=0) inside if z >= 0, top (z=worldSize) inside if z <= worldSize
            return edgePos == 0 ? point.z >= -0.01f : point.z <= worldSize + 0.01f;
        }
    }

    private Vector3? LineIntersection(Vector3 p1, Vector3 p2, bool isVerticalEdge, float edgePos) {
        if (isVerticalEdge) {
            // Intersection with vertical edge at x = edgePos
            float denom = p2.x - p1.x;
            if (Mathf.Abs(denom) < 0.0001f)
                return null;
            float t = (edgePos - p1.x) / denom;
            if (t < -0.0001f || t > 1.0001f)
                return null;
            return new Vector3(edgePos, p1.y, p1.z + t * (p2.z - p1.z));
        } else {
            // Intersection with horizontal edge at z = edgePos
            float denom = p2.z - p1.z;
            if (Mathf.Abs(denom) < 0.0001f)
                return null;
            float t = (edgePos - p1.z) / denom;
            if (t < -0.0001f || t > 1.0001f)
                return null;
            return new Vector3(p1.x + t * (p2.x - p1.x), p1.y, edgePos);
        }
    }

    private GameObject CreateRegionMesh(VoronoiRegion region) {
        var go = new GameObject($"VoronoiRegion_{region.Id}");
        go.transform.SetParent(transform);
        go.layer = LayerMask.NameToLayer("Buildings"); // Reuse the Buildings layer

        var meshFilter = go.AddComponent<MeshFilter>();
        meshFilter.mesh = BuildPolygonMesh(region.Polygon);

        var meshRenderer = go.AddComponent<MeshRenderer>();
        // Use Transparent/VertexLit shader for proper alpha support
        var shader = Shader.Find("Transparent/VertexLit");
        if (shader == null)
            shader = Shader.Find("Transparent/Diffuse");
        if (shader == null)
            shader = Shader.Find("Standard");
        var material = new Material(shader);
        material.color = TerrainColors.Unassigned;
        meshRenderer.material = material;

        var meshCollider = go.AddComponent<MeshCollider>();
        meshCollider.convex = false;

        return go;
    }

    private Mesh BuildPolygonMesh(List<Vector3> polygon) {
        // Force Y = 0.05 on all verts, then fan triangulation from vertex 0
        var verts = polygon
            .Select(v => new Vector3(v.x, PolygonY, v.z))
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

    public void SetRegionTerrain(int regionId, TerrainType type) {
        var region = TerrainData.GetRegion(regionId);
        if (region == null)
            return;

        // Enforce boundary constraint: only edge regions can be Sea or Mountain
        if ((type == TerrainType.Sea || type == TerrainType.Mountains) && !TouchesBoundary(region)) {
            Debug.LogWarning($"Cannot assign {type} to interior region {regionId}. Only boundary regions can be Sea or Mountains.");
            return;
        }

        TerrainData.SetRegionTerrain(regionId, type);
        if (regionMaterials.TryGetValue(regionId, out var material))
            material.color = TerrainColors.For(type);
    }

    public VoronoiRegion GetRegionAtWorldPos(Vector3 pos) {
        return TerrainData.GetRegionAtWorldPos(pos);
    }

    public void HighlightRegion(int regionId) {
        var region = TerrainData.GetRegion(regionId);
        if (region == null)
            return;

        if (!regionMaterials.TryGetValue(regionId, out var material))
            return;

        var currentColor = region.AssignedType.HasValue
            ? TerrainColors.For(region.AssignedType.Value)
            : TerrainColors.Unassigned;
        material.color = new Color(
            Mathf.Min(currentColor.r * 1.1f, 1f),
            Mathf.Min(currentColor.g * 1.1f, 1f),
            Mathf.Min(currentColor.b * 1.1f, 1f),
            currentColor.a
        );
    }

    public void ClearHighlight(int regionId) {
        var region = TerrainData.GetRegion(regionId);
        if (region == null)
            return;

        if (!regionMaterials.TryGetValue(regionId, out var material))
            return;

        material.color = region.AssignedType.HasValue
            ? TerrainColors.For(region.AssignedType.Value)
            : TerrainColors.Unassigned;
    }

    /// <summary>Adds an edge feature (cliff/river) between regions.</summary>
    public bool AddEdgeFeature(List<(int regionA, int regionB)> edges, EdgeFeature.EdgeFeatureType type, string description) {
        var feature = new EdgeFeature(edgeFeatures.Count, type, edges, description);

        if (!feature.IsValid()) {
            Debug.LogWarning($"Invalid {type} feature: {description}");
            return false;
        }

        edgeFeatures.Add(feature);

        // Mark the corresponding VoronoiEdge objects as assigned
        var assignedType = type == EdgeFeature.EdgeFeatureType.Cliff ? TerrainType.Cliffs : TerrainType.River;
        Debug.Log($"[VoronoiWorldGenerator] Assigning {assignedType} to {edges.Count} edges");

        foreach (var (regionA, regionB) in edges) {
            var voronoiEdge = FindEdge(regionA, regionB);
            Debug.Log($"[VoronoiWorldGenerator] Looking for edge {regionA}-{regionB}: found={voronoiEdge != null}");
            if (voronoiEdge != null) {
                voronoiEdge.SetAssignedFeature(assignedType);
                Debug.Log($"[VoronoiWorldGenerator] Set {regionA}-{regionB} to {assignedType}, isAssigned={voronoiEdge.IsAssigned}");
            }
        }

        Debug.Log($"Added {type} feature: {description}");
        return true;
    }

    private VoronoiEdge FindEdge(int regionA, int regionB) {
        foreach (var edge in edges) {
            if ((edge.regionA == regionA && edge.regionB == regionB) ||
                (edge.regionA == regionB && edge.regionB == regionA)) {
                return edge;
            }
        }
        return null;
    }

    /// <summary>Gets all edge features of a specific type.</summary>
    public List<EdgeFeature> GetEdgeFeaturesByType(EdgeFeature.EdgeFeatureType type) {
        var result = new List<EdgeFeature>();
        foreach (var feature in edgeFeatures) {
            if (feature.Type == type)
                result.Add(feature);
        }
        return result;
    }

    /// <summary>Gets edge features that connect two specific regions.</summary>
    public EdgeFeature GetEdgeFeatureBetween(int regionA, int regionB) {
        foreach (var feature in edgeFeatures) {
            foreach (var (a, b) in feature.Edges) {
                if ((a == regionA && b == regionB) || (a == regionB && b == regionA))
                    return feature;
            }
        }
        return null;
    }

    private void GenerateEdges() {
        var allRegions = TerrainData.GetAllRegions();

        // Find adjacent region pairs and create edge objects
        var adjacencySet = new HashSet<(int, int)>();
        int adjacentPairsFound = 0;

        for (int i = 0; i < allRegions.Count; i++) {
            for (int j = i + 1; j < allRegions.Count; j++) {
                if (AreRegionsAdjacent(allRegions[i], allRegions[j])) {
                    adjacentPairsFound++;
                    var key = (allRegions[i].Id < allRegions[j].Id)
                        ? (allRegions[i].Id, allRegions[j].Id)
                        : (allRegions[j].Id, allRegions[i].Id);
                    if (!adjacencySet.Contains(key)) {
                        adjacencySet.Add(key);
                        CreateEdgeObject(allRegions[i].Id, allRegions[j].Id);
                    }
                }
            }
        }

        Debug.Log($"[VoronoiWorldGenerator] Found {adjacentPairsFound} adjacent region pairs, created {edges.Count} edges");
    }

    private bool AreRegionsAdjacent(VoronoiRegion a, VoronoiRegion b) {
        // Simple check: if regions' polygons have vertices within close proximity, they're adjacent
        const float proximity = 1.5f;

        foreach (var vertexA in a.Polygon) {
            foreach (var vertexB in b.Polygon) {
                if (Vector3.Distance(vertexA, vertexB) < proximity)
                    return true;
            }
        }

        return false;
    }

    private void CreateEdgeObject(int regionA, int regionB) {
        var regionAData = TerrainData.GetRegion(regionA);
        var regionBData = TerrainData.GetRegion(regionB);
        if (regionAData == null || regionBData == null)
            return;

        // Find shared vertices between two regions
        var sharedVertices = FindSharedBoundaryVertices(regionAData, regionBData);
        Debug.Log($"[VoronoiWorldGenerator] Edge {regionA}-{regionB}: found {sharedVertices.Count} shared vertices");

        if (sharedVertices.Count < 2) {
            return;
        }

        // Create edge GameObject
        var edgeGO = new GameObject($"Edge_{regionA}_{regionB}");
        edgeGO.transform.SetParent(transform);
        // Put edges on a layer that will be raycast-priority (use "UI" layer or create "Edges" layer)
        int edgeLayer = LayerMask.NameToLayer("Edges");
        if (edgeLayer == -1)
            edgeLayer = LayerMask.NameToLayer("Default"); // Fallback
        edgeGO.layer = edgeLayer;
        Debug.Log($"[VoronoiWorldGenerator] Edge GameObject layer: {LayerMask.LayerToName(edgeGO.layer)}");

        // Create mesh along the boundary line
        var meshFilter = edgeGO.AddComponent<MeshFilter>();
        meshFilter.mesh = BuildBoundaryEdgeMesh(sharedVertices);

        // Add renderer with transparent material (invisible by default)
        var meshRenderer = edgeGO.AddComponent<MeshRenderer>();
        var shader = Shader.Find("Transparent/VertexLit");
        if (shader == null)
            shader = Shader.Find("Transparent/Diffuse");
        if (shader == null)
            shader = Shader.Find("Standard");

        var material = new Material(shader);
        material.color = new Color(0.8f, 0.6f, 0.2f, 0.0f); // Transparent initially
        meshRenderer.material = material;
        meshRenderer.shadowCastingMode = UnityEngine.Rendering.ShadowCastingMode.Off;

        // Add collider
        var meshCollider = edgeGO.AddComponent<MeshCollider>();
        meshCollider.convex = false;
        meshCollider.enabled = true;

        // Add VoronoiEdge component
        var edgeComponent = edgeGO.AddComponent<VoronoiEdge>();
        Vector3 start = sharedVertices[0];
        Vector3 end = sharedVertices[sharedVertices.Count - 1];
        edgeComponent.Initialize(edges.Count, regionA, regionB, start, end);

        edges.Add(edgeComponent);
    }

    private List<Vector3> FindSharedBoundaryVertices(VoronoiRegion a, VoronoiRegion b) {
        var shared = new List<Vector3>();
        const float threshold = 1.0f; // Match or exceed AreRegionsAdjacent proximity

        foreach (var vertexA in a.Polygon) {
            foreach (var vertexB in b.Polygon) {
                if (Vector3.Distance(vertexA, vertexB) < threshold) {
                    // Check if we already have this vertex
                    bool alreadyAdded = false;
                    foreach (var v in shared) {
                        if (Vector3.Distance(v, vertexA) < 0.01f) {
                            alreadyAdded = true;
                            break;
                        }
                    }
                    if (!alreadyAdded)
                        shared.Add(vertexA);
                }
            }
        }

        // Sort shared vertices along the line connecting them
        if (shared.Count >= 2) {
            Vector3 dir = (shared[shared.Count - 1] - shared[0]).normalized;
            shared.Sort((a, b) => Vector3.Dot(a - shared[0], dir).CompareTo(Vector3.Dot(b - shared[0], dir)));
        }

        return shared;
    }

    private Mesh BuildBoundaryEdgeMesh(List<Vector3> boundaryPoints) {
        // Create a mesh along the boundary line(s) between two regions
        var mesh = new Mesh();

        if (boundaryPoints.Count < 2)
            return mesh;

        // Create a strip of quads along the boundary
        var vertices = new List<Vector3>();
        var triangles = new List<int>();

        // Build quads along each segment of the boundary
        for (int i = 0; i < boundaryPoints.Count - 1; i++) {
            var p1 = boundaryPoints[i];
            var p2 = boundaryPoints[i + 1];

            // Get perpendicular direction for edge thickness
            Vector3 dir = (p2 - p1).normalized;
            Vector3 perpendicular = new Vector3(-dir.z, 0, dir.x) * (EdgeThickness / 2f);

            int baseIdx = vertices.Count;

            // Add quad vertices
            vertices.Add(new Vector3(p1.x - perpendicular.x, EdgeY, p1.z - perpendicular.z));
            vertices.Add(new Vector3(p1.x + perpendicular.x, EdgeY, p1.z + perpendicular.z));
            vertices.Add(new Vector3(p2.x + perpendicular.x, EdgeY, p2.z + perpendicular.z));
            vertices.Add(new Vector3(p2.x - perpendicular.x, EdgeY, p2.z - perpendicular.z));

            // Add triangles for this quad
            triangles.Add(baseIdx + 0);
            triangles.Add(baseIdx + 1);
            triangles.Add(baseIdx + 2);
            triangles.Add(baseIdx + 0);
            triangles.Add(baseIdx + 2);
            triangles.Add(baseIdx + 3);
        }

        mesh.vertices = vertices.ToArray();
        mesh.triangles = triangles.ToArray();
        mesh.RecalculateNormals();

        return mesh;
    }

    public void HighlightEdge(VoronoiEdge edge) {
        edge.Highlight();
    }

    public void ClearEdgeHighlight(VoronoiEdge edge) {
        edge.ClearHighlight();
    }
}

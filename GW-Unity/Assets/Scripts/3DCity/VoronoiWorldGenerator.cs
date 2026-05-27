using UnityEngine;
using System.Collections.Generic;
using System.Linq;

/// <summary>
/// Generates and renders Voronoi regions covering the world.
/// Uses a two-pass approach (fine cells → greedy seed selection → merged regions)
/// with staggered sentinels, matching TerrainVoronoiGenerator.js from the web implementation.
/// Data lives in GameStateManager.WorldTerrainData; meshes are owned here.
/// </summary>
public class VoronoiWorldGenerator : MonoBehaviour
{
    [SerializeField] public int regionCount = 15;
    public float worldSize = 50f;

    public TerrainData TerrainData => GameStateManager.Instance?.WorldTerrainData;

    private Dictionary<int, GameObject> regionMeshObjects = new();
    private Dictionary<int, Material>   regionMaterials   = new();
    private List<EdgeFeature>            edgeFeatures      = new();
    private List<VoronoiEdge>            edges             = new();

    public IReadOnlyList<EdgeFeature> EdgeFeatures => edgeFeatures;
    public IReadOnlyList<VoronoiEdge> Edges => edges;

    private const float PolygonY     = 0.05f;
    private const float EdgeY        = 0.10f;
    private const float EdgeThickness = 0.5f;

    // ══════════════════════════════════════════════════════════════════
    // Internal generation data (not persisted after Generate())
    // ══════════════════════════════════════════════════════════════════

    private class FineCell
    {
        public Vector2              Seed;
        public List<VoronoiUtils.VPoint> Polygon;   // circumcenter VPoint objects (shared references)
        public List<Vector2>        ClippedPolygon; // set after world-rect clip
        public int                  ParentRegionId = -1;
    }

    // ══════════════════════════════════════════════════════════════════
    // Public entry point
    // ══════════════════════════════════════════════════════════════════

    public void Generate()
    {
        if (TerrainData == null) { Debug.LogError("[VoronoiWorldGenerator] WorldTerrainData is null"); return; }
        TerrainData.WorldSize = worldSize;

        int fineCount = Mathf.Max(regionCount * 10, 150);
        Debug.Log($"[VoronoiWorldGenerator] Generating {fineCount} fine cells → {regionCount} regions");

        // Step 1: Fine-cell Voronoi with staggered sentinels
        var allFine = GenerateRawVoronoi(fineCount);
        var valid   = allFine.Where(c =>
            c.Polygon != null && c.Polygon.Count >= 3 &&
            c.Seed.x >= 0 && c.Seed.x <= worldSize &&
            c.Seed.y >= 0 && c.Seed.y <= worldSize).ToList();
        Debug.Log($"[VoronoiWorldGenerator] {valid.Count}/{fineCount} fine cells valid");

        // Step 2: Select region seeds (greedy farthest-point from interior fine cells)
        var seeds = SelectSeeds(valid, regionCount);
        Debug.Log($"[VoronoiWorldGenerator] Selected {seeds.Count} seeds");

        // Step 3: Assign fine cells to nearest region seed
        for (int i = 0; i < valid.Count; i++)
            valid[i].ParentRegionId = FindNearestSeed(valid[i].Seed, seeds);

        // Step 4: Assign global IDs to circumcenter vertices (before any clipping)
        int nextVId = 0;
        var seenVerts = new HashSet<VoronoiUtils.VPoint>();
        foreach (var cell in valid)
            foreach (var v in cell.Polygon)
                if (seenVerts.Add(v)) v.Id = nextVId++;

        // Step 5: Boundary edge detection via reference equality on unclipped polygons
        var (edgeData, edgePoints) = GenerateBoundaryEdges(valid);
        Debug.Log($"[VoronoiWorldGenerator] Generated {edgeData.Count} boundary edges");

        // Step 5.5: Clip fine-cell polygons to world bounds (after edge detection)
        var worldRect = new List<Vector2> {
            new(0,0), new(worldSize,0), new(worldSize,worldSize), new(0,worldSize) };
        foreach (var cell in valid)
        {
            var clipped = VoronoiUtils.ClipToPolygon(VoronoiUtils.VPointsToV2(cell.Polygon), worldRect);
            cell.ClippedPolygon = clipped ?? VoronoiUtils.VPointsToV2(cell.Polygon);
        }

        // Step 6: Build merged region polygons (convex hull of all fine-cell verts per region)
        var vertsByRegion = new Dictionary<int, List<Vector2>>();
        for (int i = 0; i < seeds.Count; i++) vertsByRegion[i] = new List<Vector2>();
        foreach (var cell in valid)
        {
            if (!vertsByRegion.ContainsKey(cell.ParentRegionId)) continue;
            var bucket = vertsByRegion[cell.ParentRegionId];
            foreach (var v in cell.ClippedPolygon)
                if (float.IsFinite(v.x) && float.IsFinite(v.y)) bucket.Add(v);
        }

        for (int i = 0; i < seeds.Count; i++)
        {
            var hull = VoronoiUtils.ConvexHull(vertsByRegion[i]);
            if (hull.Count < 3) continue;

            var seed = seeds[i];
            var region = new VoronoiRegion(i, new Vector3(seed.x, 0f, seed.y),
                Mathf.FloorToInt(seed.x / 10f), Mathf.FloorToInt(seed.y / 10f))
            {
                Polygon      = VoronoiUtils.ToVector3(hull),
                AssignedType = null
            };
            TerrainData.AddRegion(region);

            var meshGO = CreateRegionMesh(region);
            regionMeshObjects[i] = meshGO;
            regionMaterials[i]   = meshGO.GetComponent<MeshRenderer>().material;
        }

        IdentifyCityRegion();
        CreateEdgeObjects(edgeData, edgePoints);
    }

    // ══════════════════════════════════════════════════════════════════
    // Two-pass generation helpers
    // ══════════════════════════════════════════════════════════════════

    private List<FineCell> GenerateRawVoronoi(int count)
    {
        var seedPts    = new List<Vector2>(count);
        var allPts     = new List<Vector2>(count + 80);  // seeds + sentinels

        for (int i = 0; i < count; i++)
            seedPts.Add(new Vector2(Random.value * worldSize, Random.value * worldSize));

        foreach (var sp in seedPts) allPts.Add(sp);

        // Staggered sentinels 3× worldSize outside each edge.
        // Opposite sides use half-step offset (a vs b) to prevent collinear degenerate triangles.
        float sm   = worldSize * 3f;
        int   nSt  = 8;
        float step = worldSize / nSt;
        for (int i = 0; i <= nSt; i++)
        {
            float a = i * step - step * 0.25f;
            float b = i * step + step * 0.25f;
            allPts.Add(new Vector2(a,              -sm));
            allPts.Add(new Vector2(b,              worldSize + sm));
            allPts.Add(new Vector2(-sm,            a));
            allPts.Add(new Vector2(worldSize + sm, b));
        }
        allPts.Add(new Vector2(-sm,            -sm));
        allPts.Add(new Vector2(worldSize + sm, -sm));
        allPts.Add(new Vector2(-sm,            worldSize + sm));
        allPts.Add(new Vector2(worldSize + sm, worldSize + sm));

        var res  = VoronoiUtils.Triangulate(allPts);
        var tris = res.Triangles;
        var pts  = res.Points;

        // Build vertex → triangles map
        var vertexTris = new Dictionary<int, List<VoronoiUtils.VTriangle>>();
        foreach (var tri in tris)
            for (int i = 0; i < 3; i++)
            {
                int id = tri.Vertices[i].Id;
                if (!vertexTris.TryGetValue(id, out var list))
                    vertexTris[id] = list = new List<VoronoiUtils.VTriangle>();
                list.Add(tri);
            }

        var cells = new List<FineCell>(count);
        for (int i = 0; i < count; i++)   // only real seeds, not sentinels
        {
            var pt   = pts[i];
            var seed = seedPts[i];
            if (!vertexTris.TryGetValue(pt.Id, out var ptTris) || ptTris.Count == 0) continue;

            // Collect circumcenter VPoint objects — these are the shared references used in edge detection
            var circumcenters = new List<VoronoiUtils.VPoint>(ptTris.Count);
            foreach (var tri in ptTris)
                if (!tri.Degenerate) circumcenters.Add(tri.Circumcenter);

            if (circumcenters.Count < 3) continue;

            // Convex hull on circumcenters to guarantee convex polygon and correct ordering.
            // (angle-sort fails ~15 % of boundary cells where sentinels cluster at similar angles.)
            var hull2d = VoronoiUtils.ConvexHull(circumcenters.Select(v => new Vector2(v.X, v.Y)).ToList());
            // Remap hull vertices back to VPoint objects by position
            var hullVPoints = new List<VoronoiUtils.VPoint>(hull2d.Count);
            foreach (var hv in hull2d)
            {
                var match = circumcenters.Find(v => Mathf.Abs(v.X - hv.x) < 1e-5f && Mathf.Abs(v.Y - hv.y) < 1e-5f);
                if (match != null) hullVPoints.Add(match);
            }
            if (hullVPoints.Count < 3) continue;

            cells.Add(new FineCell { Seed = seed, Polygon = hullVPoints });
        }

        return cells;
    }

    private List<Vector2> SelectSeeds(List<FineCell> cells, int count)
    {
        float margin = worldSize * 0.15f;
        var pool   = cells.Where(c =>
            c.Seed.x >= margin && c.Seed.x <= worldSize - margin &&
            c.Seed.y >= margin && c.Seed.y <= worldSize - margin).ToList();
        var source = pool.Count >= count ? pool : cells;

        var selected = new List<Vector2>(count);
        var usedIdx  = new HashSet<int>();

        // Start from cell closest to world centre
        float cx = worldSize * 0.5f, cy = worldSize * 0.5f;
        int   bestIdx = 0; float bestDist = float.MaxValue;
        for (int i = 0; i < source.Count; i++)
        {
            float d = (source[i].Seed.x - cx) * (source[i].Seed.x - cx) +
                      (source[i].Seed.y - cy) * (source[i].Seed.y - cy);
            if (d < bestDist) { bestDist = d; bestIdx = i; }
        }
        selected.Add(source[bestIdx].Seed);
        usedIdx.Add(bestIdx);

        while (selected.Count < count)
        {
            int   farthest = -1; float farthestDist = float.MinValue;
            for (int i = 0; i < source.Count; i++)
            {
                if (usedIdx.Contains(i)) continue;
                float minD = float.MaxValue;
                foreach (var s in selected)
                {
                    float d = (source[i].Seed.x - s.x)*(source[i].Seed.x - s.x) +
                              (source[i].Seed.y - s.y)*(source[i].Seed.y - s.y);
                    if (d < minD) minD = d;
                }
                if (minD > farthestDist) { farthestDist = minD; farthest = i; }
            }
            if (farthest == -1) break;
            selected.Add(source[farthest].Seed);
            usedIdx.Add(farthest);
        }

        return selected;
    }

    private int FindNearestSeed(Vector2 point, List<Vector2> seeds)
    {
        int nearest = 0; float minD = float.MaxValue;
        for (int i = 0; i < seeds.Count; i++)
        {
            float d = (point.x - seeds[i].x)*(point.x - seeds[i].x) +
                      (point.y - seeds[i].y)*(point.y - seeds[i].y);
            if (d < minD) { minD = d; nearest = i; }
        }
        return nearest;
    }

    // ──────────────────────────────────────────────────────────────────
    // Boundary edge detection
    // ──────────────────────────────────────────────────────────────────

    private class EdgeDatum
    {
        public int RegionA, RegionB;
        public List<Vector2> Polyline;   // ordered boundary polyline
    }

    private (List<EdgeDatum> edges, List<Vector2> edgePoints) GenerateBoundaryEdges(List<FineCell> cells)
    {
        // Map from VPoint object → list of cells containing it
        var vertexCells = new Dictionary<VoronoiUtils.VPoint, List<FineCell>>();
        foreach (var cell in cells)
            foreach (var v in cell.Polygon)
            {
                if (!vertexCells.TryGetValue(v, out var list))
                    vertexCells[v] = list = new List<FineCell>();
                list.Add(cell);
            }

        var segsByEdge  = new Dictionary<string, List<(VoronoiUtils.VPoint va, VoronoiUtils.VPoint vb)>>();
        var metaByEdge  = new Dictionary<string, (int rA, int rB)>();
        var seenPairs   = new HashSet<long>();

        foreach (var cell in cells)
        {
            int rA   = cell.ParentRegionId;
            var poly = cell.Polygon;

            for (int i = 0; i < poly.Count; i++)
            {
                var va = poly[i];
                var vb = poly[(i + 1) % poly.Count];
                if (va.Id < 0 || vb.Id < 0) continue;

                int lo = System.Math.Min(va.Id, vb.Id), hi = System.Math.Max(va.Id, vb.Id);
                long pairKey = ((long)lo << 32) | (uint)hi;
                if (!seenPairs.Add(pairKey)) continue;

                // Find cells containing BOTH va and vb
                var cellsOfB = new HashSet<FineCell>(vertexCells.GetValueOrDefault(vb) ?? new List<FineCell>());
                var shared   = (vertexCells.GetValueOrDefault(va) ?? new List<FineCell>()).Where(c => cellsOfB.Contains(c)).ToList();
                var neighborIds = shared.Select(c => c.ParentRegionId).Where(r => r != rA).Distinct().ToList();
                if (neighborIds.Count == 0) continue;

                int rB  = neighborIds[0];
                int rLo = System.Math.Min(rA, rB), rHi = System.Math.Max(rA, rB);
                string eKey = $"{rLo}-{rHi}";

                if (!segsByEdge.ContainsKey(eKey)) { segsByEdge[eKey] = new(); metaByEdge[eKey] = (rLo, rHi); }
                segsByEdge[eKey].Add((va, vb));
            }
        }

        var edgeList = new List<EdgeDatum>();
        var usedVerts = new HashSet<VoronoiUtils.VPoint>();

        foreach (var kv in segsByEdge)
        {
            var polyline = SortSegmentsIntoPolyline(kv.Value);
            if (polyline.Count < 2) continue;
            foreach (var v in polyline) usedVerts.Add(v);

            var (rA, rB) = metaByEdge[kv.Key];
            edgeList.Add(new EdgeDatum { RegionA = rA, RegionB = rB,
                Polyline = polyline.Select(v => new Vector2(v.X, v.Y)).ToList() });
        }

        var edgePts = usedVerts.Select(v => new Vector2(v.X, v.Y)).ToList();
        return (edgeList, edgePts);
    }

    private List<VoronoiUtils.VPoint> SortSegmentsIntoPolyline(
        List<(VoronoiUtils.VPoint va, VoronoiUtils.VPoint vb)> segs)
    {
        if (segs.Count == 0) return new List<VoronoiUtils.VPoint>();
        if (segs.Count == 1) return new List<VoronoiUtils.VPoint> { segs[0].va, segs[0].vb };

        var adj = new Dictionary<VoronoiUtils.VPoint, List<(int idx, VoronoiUtils.VPoint other)>>();
        for (int i = 0; i < segs.Count; i++)
        {
            var (va, vb) = segs[i];
            if (!adj.ContainsKey(va)) adj[va] = new();
            if (!adj.ContainsKey(vb)) adj[vb] = new();
            adj[va].Add((i, vb));
            adj[vb].Add((i, va));
        }

        VoronoiUtils.VPoint start = segs[0].va;
        foreach (var kv in adj) if (kv.Value.Count == 1) { start = kv.Key; break; }

        var result  = new List<VoronoiUtils.VPoint> { start };
        var used    = new HashSet<int>();
        var current = start;

        while (used.Count < segs.Count)
        {
            bool found = false;
            foreach (var (idx, other) in adj.GetValueOrDefault(current) ?? new List<(int, VoronoiUtils.VPoint)>())
            {
                if (used.Contains(idx)) continue;
                used.Add(idx); result.Add(other); current = other; found = true; break;
            }
            if (!found) break;
        }
        return result;
    }

    // ══════════════════════════════════════════════════════════════════
    // Edge GameObject creation
    // ══════════════════════════════════════════════════════════════════

    private void CreateEdgeObjects(List<EdgeDatum> edgeData, List<Vector2> edgePoints)
    {
        foreach (var ed in edgeData)
        {
            if (ed.Polyline.Count < 2) continue;

            var go = new GameObject($"Edge_{ed.RegionA}_{ed.RegionB}");
            go.transform.SetParent(transform);
            int layer = LayerMask.NameToLayer("Edges");
            go.layer = layer < 0 ? LayerMask.NameToLayer("Default") : layer;

            var pts3 = ed.Polyline.Select(v => new Vector3(v.x, EdgeY, v.y)).ToList();

            var mf = go.AddComponent<MeshFilter>();
            mf.mesh = BuildBoundaryEdgeMesh(pts3);

            var mr     = go.AddComponent<MeshRenderer>();
            var shader = Shader.Find("Transparent/VertexLit") ?? Shader.Find("Transparent/Diffuse") ?? Shader.Find("Standard");
            var mat    = new Material(shader) { color = new Color(0.8f, 0.6f, 0.2f, 0f) };
            mr.material = mat;
            mr.shadowCastingMode = UnityEngine.Rendering.ShadowCastingMode.Off;

            var mc = go.AddComponent<MeshCollider>();
            mc.convex = false;

            var ec = go.AddComponent<VoronoiEdge>();
            ec.Initialize(edges.Count, ed.RegionA, ed.RegionB, pts3[0], pts3[pts3.Count - 1]);
            edges.Add(ec);
        }
    }

    // ══════════════════════════════════════════════════════════════════
    // City region identification
    // ══════════════════════════════════════════════════════════════════

    private void IdentifyCityRegion()
    {
        var all      = TerrainData.GetAllRegions();
        var interior = all.Where(r => !TouchesBoundary(r)).ToList();
        var city     = interior.Count > 0
            ? interior.OrderByDescending(r => r.Polygon.Count).First()
            : all.OrderByDescending(r => r.Polygon.Count).First();
        SetCityRegion(city);
    }

    private bool TouchesBoundary(VoronoiRegion region)
    {
        const float margin = 0.5f;
        return region.Polygon.Any(v =>
            v.x < margin || v.x > worldSize - margin ||
            v.z < margin || v.z > worldSize - margin);
    }

    private void SetCityRegion(VoronoiRegion region)
    {
        TerrainData.SetRegionTerrain(region.Id, TerrainType.City);
        if (regionMaterials.TryGetValue(region.Id, out var mat))
            mat.color = TerrainColors.For(TerrainType.City);
        Debug.Log($"[VoronoiWorldGenerator] City region: {region.Id} at {region.SeedPoint}");
    }

    // ══════════════════════════════════════════════════════════════════
    // Public API (terrain assignment, hover, edge features)
    // ══════════════════════════════════════════════════════════════════

    public void SetRegionTerrain(int regionId, TerrainType type)
    {
        var region = TerrainData.GetRegion(regionId);
        if (region == null) return;

        // Desert, Mountains, Sea are edge-only
        if ((type == TerrainType.Sea || type == TerrainType.Mountains || type == TerrainType.Desert)
            && !TouchesBoundary(region))
        {
            Debug.LogWarning($"Cannot assign {type} to interior region {regionId}.");
            return;
        }

        // Sea and Lake cannot be adjacent to each other
        if (type == TerrainType.Sea || type == TerrainType.Lake)
        {
            TerrainType forbidden = type == TerrainType.Sea ? TerrainType.Lake : TerrainType.Sea;
            foreach (var e in edges)
            {
                if (e.regionA != regionId && e.regionB != regionId) continue;
                int otherId = e.regionA == regionId ? e.regionB : e.regionA;
                var other = TerrainData.GetRegion(otherId);
                if (other?.AssignedType == forbidden)
                {
                    Debug.LogWarning($"Cannot assign {type} to region {regionId}: adjacent to {forbidden}.");
                    return;
                }
            }
        }

        TerrainData.SetRegionTerrain(regionId, type);
        if (regionMaterials.TryGetValue(regionId, out var mat)) mat.color = TerrainColors.For(type);

        // Assigning Sea or Lake clears any adjacent River edges
        if (type == TerrainType.Lake || type == TerrainType.Sea)
        {
            foreach (var e in edges)
            {
                if (e.regionA != regionId && e.regionB != regionId) continue;
                if (!e.IsAssigned || e.AssignedFeatureType != TerrainType.River) continue;
                e.ClearAssignment();
                edgeFeatures.RemoveAll(f => f.Type == EdgeFeature.EdgeFeatureType.River &&
                    f.Edges.Exists(p => (p.regionA == e.regionA && p.regionB == e.regionB) ||
                                        (p.regionA == e.regionB && p.regionB == e.regionA)));
            }
        }
    }

    /// <summary>Whether the region touches the world boundary. Exposed for SetupPhase validation.</summary>
    public bool IsEdgeRegion(VoronoiRegion region) => TouchesBoundary(region);

    /// <summary>
    /// Validates that every river terminates at the world edge, a Lake, Sea, or Mountain,
    /// or joins another river. Returns an error string, or null if valid.
    /// </summary>
    public string ValidateRiverEndpoints()
    {
        const float eps = 1.0f;
        var VALID_TYPES = new System.Collections.Generic.HashSet<TerrainType>
            { TerrainType.Lake, TerrainType.Sea, TerrainType.Mountains };

        var riverEdges = new List<VoronoiEdge>();
        foreach (var e in edges)
            if (e.IsAssigned && e.AssignedFeatureType == TerrainType.River) riverEdges.Add(e);

        if (riverEdges.Count == 0) return null;

        // Count how many river edges share each endpoint (start/end point of edge polyline)
        var endpointCount = new System.Collections.Generic.Dictionary<string, int>();
        string PointKey(Vector3 p) =>
            $"{System.Math.Round(p.x, 2):F2},{System.Math.Round(p.z, 2):F2}";

        foreach (var re in riverEdges)
        {
            var sk = PointKey(re.edgeStartPoint); var ek = PointKey(re.edgeEndPoint);
            endpointCount[sk] = endpointCount.GetValueOrDefault(sk, 0) + 1;
            endpointCount[ek] = endpointCount.GetValueOrDefault(ek, 0) + 1;
        }

        foreach (var re in riverEdges)
        {
            foreach (var pt in new[] { re.edgeStartPoint, re.edgeEndPoint })
            {
                if (endpointCount.GetValueOrDefault(PointKey(pt), 0) > 1) continue; // junction — valid

                // On world boundary?
                if (pt.x <= eps || pt.x >= worldSize - eps ||
                    pt.z <= eps || pt.z >= worldSize - eps) continue;

                // Adjacent region is Lake, Sea, or Mountains?
                var rA = TerrainData.GetRegion(re.regionA);
                var rB = TerrainData.GetRegion(re.regionB);
                bool ok = (rA?.AssignedType.HasValue == true && VALID_TYPES.Contains(rA.AssignedType.Value)) ||
                          (rB?.AssignedType.HasValue == true && VALID_TYPES.Contains(rB.AssignedType.Value));
                if (!ok)
                    return "Every river must start and end at the map edge, a Lake, Sea, or Mountain, or join another river.";
            }
        }

        return null;
    }

    public VoronoiRegion GetRegionAtWorldPos(Vector3 pos) => TerrainData.GetRegionAtWorldPos(pos);

    public void HighlightRegion(int regionId)
    {
        var region = TerrainData.GetRegion(regionId);
        if (region == null || !regionMaterials.TryGetValue(regionId, out var mat)) return;
        var c = region.AssignedType.HasValue ? TerrainColors.For(region.AssignedType.Value) : TerrainColors.Unassigned;
        mat.color = new Color(Mathf.Min(c.r*1.1f,1f), Mathf.Min(c.g*1.1f,1f), Mathf.Min(c.b*1.1f,1f), c.a);
    }

    public void ClearHighlight(int regionId)
    {
        var region = TerrainData.GetRegion(regionId);
        if (region == null || !regionMaterials.TryGetValue(regionId, out var mat)) return;
        mat.color = region.AssignedType.HasValue ? TerrainColors.For(region.AssignedType.Value) : TerrainColors.Unassigned;
    }

    public bool AddEdgeFeature(List<(int regionA, int regionB)> edgePairs, EdgeFeature.EdgeFeatureType type, string description)
    {
        var feature = new EdgeFeature(edgeFeatures.Count, type, edgePairs, description);
        if (!feature.IsValid()) { Debug.LogWarning($"Invalid {type} feature: {description}"); return false; }

        edgeFeatures.Add(feature);
        var assignedType = type == EdgeFeature.EdgeFeatureType.Cliff ? TerrainType.Cliffs : TerrainType.River;
        foreach (var (rA, rB) in edgePairs)
        {
            var e = FindEdge(rA, rB);
            if (e != null) e.SetAssignedFeature(assignedType);
        }
        return true;
    }

    public VoronoiEdge FindEdge(int rA, int rB)
    {
        foreach (var e in edges)
            if ((e.regionA == rA && e.regionB == rB) || (e.regionA == rB && e.regionB == rA)) return e;
        return null;
    }

    public List<EdgeFeature> GetEdgeFeaturesByType(EdgeFeature.EdgeFeatureType type)
        => edgeFeatures.Where(f => f.Type == type).ToList();

    public EdgeFeature GetEdgeFeatureBetween(int rA, int rB)
    {
        foreach (var f in edgeFeatures)
            foreach (var (a, b) in f.Edges)
                if ((a == rA && b == rB) || (a == rB && b == rA)) return f;
        return null;
    }

    public void HighlightEdge(VoronoiEdge edge)      => edge.Highlight();
    public void ClearEdgeHighlight(VoronoiEdge edge) => edge.ClearHighlight();

    // ══════════════════════════════════════════════════════════════════
    // Mesh builders
    // ══════════════════════════════════════════════════════════════════

    private GameObject CreateRegionMesh(VoronoiRegion region)
    {
        var go = new GameObject($"VoronoiRegion_{region.Id}");
        go.transform.SetParent(transform);
        go.layer = LayerMask.NameToLayer("Buildings");

        var mf = go.AddComponent<MeshFilter>();
        mf.mesh = BuildPolygonMesh(region.Polygon);

        var mr     = go.AddComponent<MeshRenderer>();
        var shader = Shader.Find("Transparent/VertexLit") ?? Shader.Find("Transparent/Diffuse") ?? Shader.Find("Standard");
        var mat    = new Material(shader) { color = TerrainColors.Unassigned };
        mr.material = mat;

        go.AddComponent<MeshCollider>().convex = false;
        return go;
    }

    private Mesh BuildPolygonMesh(List<Vector3> polygon)
    {
        var verts = polygon.Select(v => new Vector3(v.x, PolygonY, v.z)).ToArray();
        int n = verts.Length;
        var tris = new int[(n - 2) * 3];
        int t = 0;
        for (int i = 1; i <= n - 2; i++) { tris[t++] = 0; tris[t++] = i + 1; tris[t++] = i; }
        var mesh = new Mesh { vertices = verts, triangles = tris };
        mesh.RecalculateNormals();
        return mesh;
    }

    private Mesh BuildBoundaryEdgeMesh(List<Vector3> pts)
    {
        var verts = new List<Vector3>();
        var tris  = new List<int>();

        for (int i = 0; i < pts.Count - 1; i++)
        {
            var p1 = pts[i]; var p2 = pts[i + 1];
            var dir  = (p2 - p1).normalized;
            var perp = new Vector3(-dir.z, 0, dir.x) * (EdgeThickness * 0.5f);
            int b = verts.Count;
            verts.Add(new Vector3(p1.x - perp.x, EdgeY, p1.z - perp.z));
            verts.Add(new Vector3(p1.x + perp.x, EdgeY, p1.z + perp.z));
            verts.Add(new Vector3(p2.x + perp.x, EdgeY, p2.z + perp.z));
            verts.Add(new Vector3(p2.x - perp.x, EdgeY, p2.z - perp.z));
            tris.AddRange(new[] { b, b+1, b+2, b, b+2, b+3 });
        }

        var mesh = new Mesh { vertices = verts.ToArray(), triangles = tris.ToArray() };
        mesh.RecalculateNormals();
        return mesh;
    }
}

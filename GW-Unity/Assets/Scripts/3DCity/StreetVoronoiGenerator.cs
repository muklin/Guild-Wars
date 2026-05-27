using System;
using System.Collections.Generic;
using System.Linq;
using UnityEngine;

// ══════════════════════════════════════════════════════════════════════
// Data types
// ══════════════════════════════════════════════════════════════════════

public class StreetNode
{
    public int   Id;
    public float X, Y;   // XZ world-plane coords (Y maps to Unity Z)
    public Vector3 ToV3(float height = 0f) => new Vector3(X, height, Y);
}

public class StreetEdge
{
    public string Id;
    public int    NodeA, NodeB;
    public string Type;       // "Stone" | "Brick" | "Mud"
    public int    DistrictId;
}

public class StreetGraph
{
    public List<StreetNode>         Nodes;
    public List<StreetEdge>         Edges;
    public List<VoronoiUtils.VoronoiCell> Cells;  // lot outlines per district
}

/// <summary>Represents one city district boundary edge with type info.</summary>
public class CityEdgeData
{
    public int    DistrictA, DistrictB;
    public string AssignedType;   // "Mud" | "Brick" | "Stone" | "Wall" | etc.
    public List<Vector2> Points;  // ordered polyline in XZ plane
}

// ══════════════════════════════════════════════════════════════════════
// Generator
// ══════════════════════════════════════════════════════════════════════

/// <summary>
/// Generates the per-district micro-Voronoi street network.
/// Port of StreetVoronoiGenerator.js.
/// Call Generate() with the city's districts and their shared boundary edges.
/// </summary>
public class StreetVoronoiGenerator
{
    private const float SnapThreshold    = 0.25f;
    private const float BoundaryInterval = 1.0f;

    // ──────────────────────────────────────────────────────────────────
    // District street parameters (mirrors JS DISTRICT_STREET_PARAMS)
    // ──────────────────────────────────────────────────────────────────

    private struct StreetParams
    {
        public float Interval, Density, XYRatio, Jitter;
        public VoronoiUtils.VoronoiMetric Metric;
    }

    private static readonly Dictionary<string, StreetParams> DistrictParams = new()
    {
        ["Leadership"]          = new() { Interval=0.5f, Density=1.0f, XYRatio=2.0f, Jitter=0.2f, Metric=VoronoiUtils.VoronoiMetric.Manhattan },
        ["Market"]              = new() { Interval=1.0f, Density=1.0f, XYRatio=4.0f, Jitter=0.1f, Metric=VoronoiUtils.VoronoiMetric.Chebyshev },
        ["Residential-Slums"]   = new() { Interval=1.5f, Density=2.0f, XYRatio=1.0f, Jitter=0.9f, Metric=VoronoiUtils.VoronoiMetric.Manhattan },
        ["Residential-Middle"]  = new() { Interval=1.5f, Density=0.4f, XYRatio=2.0f, Jitter=0.2f, Metric=VoronoiUtils.VoronoiMetric.Manhattan },
        ["Residential-Noble"]   = new() { Interval=1.5f, Density=0.4f, XYRatio=1.0f, Jitter=0.5f, Metric=VoronoiUtils.VoronoiMetric.Manhattan },
        ["Religious"]           = new() { Interval=0.5f, Density=1.5f, XYRatio=1.0f, Jitter=0.1f, Metric=VoronoiUtils.VoronoiMetric.Centroid  },
        ["Magical"]             = new() { Interval=0.6f, Density=2.0f, XYRatio=1.0f, Jitter=0.5f, Metric=VoronoiUtils.VoronoiMetric.Centroid  },
        ["Military"]            = new() { Interval=0.1f, Density=1.0f, XYRatio=2.0f, Jitter=0.1f, Metric=VoronoiUtils.VoronoiMetric.Chebyshev },
        ["Industry"]            = new() { Interval=1.2f, Density=0.2f, XYRatio=2.5f, Jitter=0.1f, Metric=VoronoiUtils.VoronoiMetric.Chebyshev },
        ["Entertainment"]       = new() { Interval=0.5f, Density=2.0f, XYRatio=1.0f, Jitter=0.9f, Metric=VoronoiUtils.VoronoiMetric.Manhattan },
    };
    private static readonly StreetParams DefaultParams =
        new() { Interval=1.0f, Density=0.5f, XYRatio=1.0f, Jitter=0.3f, Metric=VoronoiUtils.VoronoiMetric.Euclidean };

    private static readonly Dictionary<string, int> StreetPriority = new()
        { ["Stone"] = 2, ["Brick"] = 1, ["Mud"] = 0 };

    // ──────────────────────────────────────────────────────────────────
    // Helpers for district → street type / params
    // ──────────────────────────────────────────────────────────────────

    private static string StreetTypeFor(DistrictClass cls)
    {
        switch (cls)
        {
            case DistrictClass.Military:                    return "Stone";
            case DistrictClass.Commerce: case DistrictClass.Noble: return "Brick";
            default:                                        return "Mud";
        }
    }

    private static string BetterStreet(string a, string b) =>
        (StreetPriority.GetValueOrDefault(a, 0) >= StreetPriority.GetValueOrDefault(b, 0)) ? a : b;

    private static StreetParams GetParams(CityDistrict d)
    {
        if (d == null) return DefaultParams;
        string key = d.Class switch
        {
            DistrictClass.Commerce     => "Market",
            DistrictClass.Military     => "Military",
            DistrictClass.Magical      => "Magical",
            DistrictClass.Religious    => "Religious",
            DistrictClass.Noble        => "Residential-Noble",
            DistrictClass.Slums        => "Residential-Slums",
            DistrictClass.Entertainment=> "Entertainment",
            DistrictClass.Industrial   => "Industry",
            _                          => "Residential-Middle",
        };
        return DistrictParams.TryGetValue(key, out var p) ? p : DefaultParams;
    }

    // ══════════════════════════════════════════════════════════════════
    // Main entry point
    // ══════════════════════════════════════════════════════════════════

    public StreetGraph Generate(List<CityDistrict> districts, List<CityEdgeData> cityEdges, int epochSeed = 0)
    {
        int nextNodeId = 0;

        var districtById = districts.ToDictionary(d => d.Id);

        // ── Per-district micro-Voronoi ────────────────────────────────
        var districtResults = new List<(int dId, List<StreetNode> nodes, List<StreetEdge> edges, List<VoronoiUtils.VoronoiCell> cells)>();

        foreach (var district in districts)
        {
            var polygon  = DistrictBoundaryV2(district);
            var streetT  = StreetTypeFor(district.Class);
            var p        = GetParams(district);

            var perimSeeds = SamplePerimeter(polygon, p.Interval);
            var intSeeds   = VoronoiUtils.GenerateGridSeeds(polygon, p.Density, p.XYRatio, p.Jitter, district.Id ^ epochSeed);
            var seeds      = perimSeeds.Concat(intSeeds).ToList();

            if (seeds.Count < 3) { districtResults.Add((district.Id, new(), new(), new())); continue; }

            var res = VoronoiUtils.Triangulate(seeds);
            var tris = res.Triangles;
            var pts  = res.Points;

            // Vertex → triangle adjacency
            var vertTris = new Dictionary<int, List<VoronoiUtils.VTriangle>>();
            foreach (var tri in tris)
                for (int i = 0; i < 3; i++)
                {
                    int id = tri.Vertices[i].Id;
                    if (!vertTris.TryGetValue(id, out var lst)) vertTris[id] = lst = new();
                    lst.Add(tri);
                }

            // Directed edge → triangles
            var edgeTriMap = new Dictionary<long, List<VoronoiUtils.VTriangle>>();
            foreach (var tri in tris)
                for (int i = 0; i < 3; i++)
                {
                    var va = tri.Vertices[i]; var vb = tri.Vertices[(i+1)%3];
                    long key = va.Id < vb.Id ? ((long)va.Id << 32)|((uint)vb.Id) : ((long)vb.Id << 32)|((uint)va.Id);
                    if (!edgeTriMap.TryGetValue(key, out var lst)) edgeTriMap[key] = lst = new();
                    lst.Add(tri);
                }

            var nodeByKey  = new Dictionary<string, StreetNode>();
            var distEdges  = new List<StreetEdge>();
            int edgeIdx    = 0;

            StreetNode GetOrCreate(float cx, float cy)
            {
                float ox = cx, oy = cy;
                if (!VoronoiUtils.PointInPolygon(cx, cy, polygon))
                {
                    var proj = VoronoiUtils.ProjectToPolygon(cx, cy, polygon);
                    ox = proj.x; oy = proj.y;
                }
                string k = $"{ox:F4},{oy:F4}";
                if (!nodeByKey.TryGetValue(k, out var node))
                    nodeByKey[k] = node = new StreetNode { Id = nextNodeId++, X = ox, Y = oy };
                return node;
            }

            foreach (var kv in edgeTriMap)
            {
                if (kv.Value.Count != 2) continue;
                if (!VoronoiUtils.TryTriangleCenter(kv.Value[0], p.Metric, out var cA)) continue;
                if (!VoronoiUtils.TryTriangleCenter(kv.Value[1], p.Metric, out var cB)) continue;

                float mx = (cA.x+cB.x)*0.5f, my = (cA.y+cB.y)*0.5f;
                if (!VoronoiUtils.PointInPolygon(mx, my, polygon)) continue;

                var nA = GetOrCreate(cA.x, cA.y);
                var nB = GetOrCreate(cB.x, cB.y);
                distEdges.Add(new StreetEdge { Id=$"street-{district.Id}-{edgeIdx++}", NodeA=nA.Id, NodeB=nB.Id, Type=streetT, DistrictId=district.Id });
            }

            // Voronoi cells per seed (lot outlines)
            var cellsOut = new List<VoronoiUtils.VoronoiCell>();
            for (int i = 0; i < seeds.Count; i++)
            {
                var seed = seeds[i];
                if (!vertTris.TryGetValue(pts[i].Id, out var ptTris) || ptTris.Count < 3) continue;
                var corners = new List<Vector2>(ptTris.Count);
                foreach (var tri in ptTris)
                    if (VoronoiUtils.TryTriangleCenter(tri, p.Metric, out var c)) corners.Add(c);
                if (corners.Count < 3) continue;
                corners.Sort((a,b) => Mathf.Atan2(a.y-seed.y, a.x-seed.x).CompareTo(Mathf.Atan2(b.y-seed.y, b.x-seed.x)));
                var clipped = VoronoiUtils.ClipToPolygon(corners, polygon);
                if (clipped != null) cellsOut.Add(new VoronoiUtils.VoronoiCell { SeedPoint=seed, Polygon=clipped });
            }

            districtResults.Add((district.Id, new List<StreetNode>(nodeByKey.Values), distEdges, cellsOut));
        }

        // ── Boundary nodes from Mud city edges ───────────────────────
        var boundaryNodeByPtId  = new Dictionary<int, StreetNode>();
        var boundaryNodes       = new List<StreetNode>();
        var boundaryEdges       = new List<StreetEdge>();
        var boundaryNodesByEdge = new Dictionary<int, List<StreetNode>>();

        for (int ei = 0; ei < cityEdges.Count; ei++)
        {
            var ce = cityEdges[ei];
            if (ce.AssignedType != "Mud") continue;
            var pts2 = ce.Points;
            if (pts2 == null || pts2.Count < 2) continue;

            var ordered = new List<StreetNode>();
            for (int i = 0; i < pts2.Count; i++)
            {
                int ptId = i; // use index as surrogate ID for boundary pts
                // reuse node keyed by rounded position
                string posKey = $"{pts2[i].x:F4},{pts2[i].y:F4}";
                if (!boundaryNodeByPtId.ContainsKey(ptId))
                {
                    var node = new StreetNode { Id = nextNodeId++, X = pts2[i].x, Y = pts2[i].y };
                    boundaryNodeByPtId[ptId] = node;
                    boundaryNodes.Add(node);
                }
                ordered.Add(boundaryNodeByPtId[ptId]);

                if (i < pts2.Count - 1)
                {
                    var p1 = pts2[i]; var p2 = pts2[i+1];
                    float dx = p2.x-p1.x, dy = p2.y-p1.y;
                    float len = Mathf.Sqrt(dx*dx+dy*dy);
                    int steps = Mathf.FloorToInt(len / BoundaryInterval);
                    for (int k = 1; k < steps; k++)
                    {
                        float t = (k * BoundaryInterval) / len;
                        if (t >= 1f) break;
                        var node = new StreetNode { Id=nextNodeId++, X=p1.x+dx*t, Y=p1.y+dy*t };
                        boundaryNodes.Add(node);
                        ordered.Add(node);
                    }
                }
            }

            string typeA = ce.DistrictA >= 0 && districtById.ContainsKey(ce.DistrictA) ? StreetTypeFor(districtById[ce.DistrictA].Class) : "Mud";
            string typeB = ce.DistrictB >= 0 && districtById.ContainsKey(ce.DistrictB) ? StreetTypeFor(districtById[ce.DistrictB].Class) : "Mud";
            string bType = BetterStreet(typeA, typeB);

            for (int i = 0; i < ordered.Count - 1; i++)
                boundaryEdges.Add(new StreetEdge { Id=$"street-boundary-{ei}-{i}", NodeA=ordered[i].Id, NodeB=ordered[i+1].Id, Type=bType, DistrictId=ce.DistrictA });

            boundaryNodesByEdge[ei] = ordered;
        }

        // ── Flatten all nodes / edges ────────────────────────────────
        var voroNodes = districtResults.SelectMany(r => r.nodes).ToList();
        var voroEdges = districtResults.SelectMany(r => r.edges).ToList();
        var allNodes  = voroNodes.Concat(boundaryNodes).ToList();
        var allEdges  = voroEdges.Concat(boundaryEdges).ToList();

        // ── Union-Find snap merge ────────────────────────────────────
        var parent = new Dictionary<int, int>();
        foreach (var n in allNodes) parent[n.Id] = n.Id;

        int Find(int id) {
            while (parent[id] != id) { parent[id] = parent[parent[id]]; id = parent[id]; } return id;
        }
        void Union(int a, int b) { int ra = Find(a), rb = Find(b); if (ra != rb) parent[rb] = ra; }

        for (int i = 0; i < allNodes.Count; i++)
            for (int j = i + 1; j < allNodes.Count; j++)
            {
                float ddx = allNodes[i].X - allNodes[j].X, ddy = allNodes[i].Y - allNodes[j].Y;
                if (ddx*ddx + ddy*ddy < SnapThreshold*SnapThreshold)
                    Union(allNodes[i].Id, allNodes[j].Id);
            }

        var rootData = new Dictionary<int, (float sx, float sy, int cnt)>();
        foreach (var n in allNodes)
        {
            int root = Find(n.Id);
            if (!rootData.TryGetValue(root, out var d)) d = (0,0,0);
            rootData[root] = (d.sx+n.X, d.sy+n.Y, d.cnt+1);
        }
        var finalNodes = rootData.Select(kv => new StreetNode { Id=kv.Key, X=kv.Value.sx/kv.Value.cnt, Y=kv.Value.sy/kv.Value.cnt }).ToList();

        var seenEdgeKeys = new HashSet<long>();
        var finalEdges   = new List<StreetEdge>();
        foreach (var e in allEdges)
        {
            int na = Find(e.NodeA), nb = Find(e.NodeB);
            if (na == nb) continue;
            long ek = na < nb ? ((long)na<<32)|(uint)nb : ((long)nb<<32)|(uint)na;
            if (!seenEdgeKeys.Add(ek)) continue;
            finalEdges.Add(new StreetEdge { Id=e.Id, NodeA=na, NodeB=nb, Type=e.Type, DistrictId=e.DistrictId });
        }

        var finalNodeById = finalNodes.ToDictionary(n => n.Id);
        var nodesByDistrict = districtResults.ToDictionary(r => r.dId,
            r => r.nodes.Select(n => (id: Find(n.Id), node: finalNodeById.GetValueOrDefault(Find(n.Id)))).Where(x => x.node != null).ToList());

        // ── Connect boundary nodes into district Voronoi ─────────────
        int connectIdx = 0;
        for (int ei = 0; ei < cityEdges.Count; ei++)
        {
            var ce = cityEdges[ei];
            if (ce.AssignedType != "Mud") continue;
            foreach (int dId in new[] { ce.DistrictA, ce.DistrictB })
            {
                if (dId < 0 || !nodesByDistrict.TryGetValue(dId, out var dNodes) || dNodes.Count == 0) continue;
                var bNodes = boundaryNodesByEdge.GetValueOrDefault(ei) ?? new List<StreetNode>();
                foreach (var bn in bNodes)
                {
                    int bId = Find(bn.Id);
                    if (!finalNodeById.TryGetValue(bId, out var bPt)) continue;
                    float bestD = float.MaxValue; int bestId = -1;
                    foreach (var (id, dn) in dNodes)
                    {
                        float d = Mathf.Sqrt((bPt.X-dn.X)*(bPt.X-dn.X)+(bPt.Y-dn.Y)*(bPt.Y-dn.Y));
                        if (d < bestD) { bestD = d; bestId = id; }
                    }
                    if (bestId >= 0 && bestId != bId)
                    {
                        long ek = bestId<bId ? ((long)bestId<<32)|(uint)bId : ((long)bId<<32)|(uint)bestId;
                        if (seenEdgeKeys.Add(ek))
                            finalEdges.Add(new StreetEdge { Id=$"street-connect-{connectIdx++}", NodeA=bestId, NodeB=bId,
                                Type=StreetTypeFor(districtById.ContainsKey(dId) ? districtById[dId].Class : DistrictClass.Neutral), DistrictId=dId });
                    }
                }
            }
        }

        // ── Cross-district connectivity for non-Mud boundaries ───────
        int crossIdx = 0;
        for (int ei = 0; ei < cityEdges.Count; ei++)
        {
            var ce = cityEdges[ei];
            if (ce.AssignedType == "Mud" || ce.DistrictB < 0) continue;
            if (!nodesByDistrict.TryGetValue(ce.DistrictA, out var nA) || !nodesByDistrict.TryGetValue(ce.DistrictB, out var nB)) continue;
            if (nA.Count == 0 || nB.Count == 0) continue;

            float bestD = float.MaxValue; int bestA = -1, bestB = -1;
            foreach (var (ia, da) in nA)
                foreach (var (ib, db) in nB)
                {
                    float d = Mathf.Sqrt((da.X-db.X)*(da.X-db.X)+(da.Y-db.Y)*(da.Y-db.Y));
                    if (d < bestD) { bestD = d; bestA = ia; bestB = ib; }
                }

            if (bestA >= 0 && bestA != bestB)
            {
                long ek = bestA<bestB ? ((long)bestA<<32)|(uint)bestB : ((long)bestB<<32)|(uint)bestA;
                if (seenEdgeKeys.Add(ek))
                    finalEdges.Add(new StreetEdge { Id=$"street-cross-{crossIdx++}", NodeA=bestA, NodeB=bestB, Type="Mud", DistrictId=ce.DistrictA });
            }
        }

        var allCells = districtResults.SelectMany(r => r.cells).ToList();
        Debug.Log($"[StreetVoronoiGenerator] {finalNodes.Count} nodes, {finalEdges.Count} edges, {allCells.Count} cells");
        return new StreetGraph { Nodes = finalNodes, Edges = finalEdges, Cells = allCells };
    }

    // ══════════════════════════════════════════════════════════════════
    // Private helpers
    // ══════════════════════════════════════════════════════════════════

    private static List<Vector2> DistrictBoundaryV2(CityDistrict d)
    {
        var result = new List<Vector2>(d.Boundary.Count);
        foreach (var v in d.Boundary) result.Add(new Vector2(v.x, v.z));
        return result;
    }

    private List<Vector2> SamplePerimeter(List<Vector2> polygon, float interval)
    {
        var seeds = new List<Vector2>();
        int n = polygon.Count;
        for (int i = 0; i < n; i++)
        {
            var v1 = polygon[i]; var v2 = polygon[(i+1)%n];
            seeds.Add(v1);
            float dx = v2.x-v1.x, dy = v2.y-v1.y;
            float len = Mathf.Sqrt(dx*dx+dy*dy);
            if (len < interval) continue;
            var (sa, sb) = CanonicalOrder(v1, v2);
            float cdx = sb.x-sa.x, cdy = sb.y-sa.y, clen = Mathf.Sqrt(cdx*cdx+cdy*cdy);
            int steps = Mathf.FloorToInt(clen / interval);
            for (int k = 1; k <= steps; k++)
            {
                float t = (k * interval) / clen;
                if (t >= 1f) break;
                seeds.Add(new Vector2(sa.x + cdx*t, sa.y + cdy*t));
            }
        }
        return seeds;
    }

    private static (Vector2, Vector2) CanonicalOrder(Vector2 a, Vector2 b)
    {
        if (a.x < b.x) return (a, b);
        if (a.x > b.x) return (b, a);
        return a.y <= b.y ? (a, b) : (b, a);
    }
}

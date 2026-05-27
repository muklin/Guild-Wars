using System;
using System.Collections.Generic;
using System.Linq;
using UnityEngine;

// ══════════════════════════════════════════════════════════════════════
// Output data types
// ══════════════════════════════════════════════════════════════════════

public enum BlockType { Square, Single, Subdivided }

public class CityBlock
{
    public int           Id;
    public int           DistrictId;
    public List<Vector2> Vertices;
    public float         Area;
    public BlockType     Type;
}

/// <summary>A building lot polygon (footprint in XZ plane). Distinct from Building (which has a position).</summary>
public class BuildingLot
{
    public int           Id;
    public int           BlockId;
    public int           DistrictId;
    public List<Vector2> Vertices;
}

public class CityBlockResult
{
    public List<CityBlock>   Blocks;
    public List<BuildingLot> Buildings;
}

// ══════════════════════════════════════════════════════════════════════
// Generator
// ══════════════════════════════════════════════════════════════════════

/// <summary>
/// Subdivides a street graph into city blocks and building lots.
/// Port of CityBlockGenerator.js — planar face tracing, block classification, Voronoi lot subdivision.
/// </summary>
public class CityBlockGenerator
{
    // ──────────────────────────────────────────────────────────────────
    // Block parameters per district type
    // ──────────────────────────────────────────────────────────────────

    private struct BlockParams
    {
        public float MinBlockSize, MaxAspectRatio, MinLotSize, LotSpacing;
        public VoronoiUtils.VoronoiMetric Metric;
    }

    private static readonly Dictionary<string, BlockParams> DistrictBlockParams = new()
    {
        ["Market"]             = new() { MinBlockSize=0.3f, MaxAspectRatio=4.0f, MinLotSize=1.0f, LotSpacing=0.50f, Metric=VoronoiUtils.VoronoiMetric.Manhattan },
        ["Military"]           = new() { MinBlockSize=0.5f, MaxAspectRatio=5.0f, MinLotSize=1.5f, LotSpacing=0.80f, Metric=VoronoiUtils.VoronoiMetric.Manhattan },
        ["Residential"]        = new() { MinBlockSize=0.3f, MaxAspectRatio=4.0f, MinLotSize=0.8f, LotSpacing=0.50f, Metric=VoronoiUtils.VoronoiMetric.Manhattan },
        ["Residential-Middle"] = new() { MinBlockSize=0.3f, MaxAspectRatio=4.0f, MinLotSize=0.8f, LotSpacing=0.50f, Metric=VoronoiUtils.VoronoiMetric.Manhattan },
        ["Residential-Noble"]  = new() { MinBlockSize=0.5f, MaxAspectRatio=3.5f, MinLotSize=1.5f, LotSpacing=0.80f, Metric=VoronoiUtils.VoronoiMetric.Manhattan },
        ["Residential-Slums"]  = new() { MinBlockSize=0.2f, MaxAspectRatio=5.0f, MinLotSize=0.5f, LotSpacing=0.35f, Metric=VoronoiUtils.VoronoiMetric.Manhattan },
        ["Leadership"]         = new() { MinBlockSize=0.8f, MaxAspectRatio=3.0f, MinLotSize=2.5f, LotSpacing=1.00f, Metric=VoronoiUtils.VoronoiMetric.Manhattan },
        ["Entertainment"]      = new() { MinBlockSize=0.3f, MaxAspectRatio=4.0f, MinLotSize=1.0f, LotSpacing=0.60f, Metric=VoronoiUtils.VoronoiMetric.Manhattan },
        ["Religious"]          = new() { MinBlockSize=0.5f, MaxAspectRatio=3.0f, MinLotSize=2.0f, LotSpacing=0.70f, Metric=VoronoiUtils.VoronoiMetric.Manhattan },
        ["Magical"]            = new() { MinBlockSize=0.3f, MaxAspectRatio=4.0f, MinLotSize=1.0f, LotSpacing=0.55f, Metric=VoronoiUtils.VoronoiMetric.Manhattan },
        ["Industry"]           = new() { MinBlockSize=0.5f, MaxAspectRatio=6.0f, MinLotSize=2.0f, LotSpacing=0.90f, Metric=VoronoiUtils.VoronoiMetric.Manhattan },
    };
    private static readonly BlockParams DefaultBlockParams =
        new() { MinBlockSize=0.3f, MaxAspectRatio=4.0f, MinLotSize=1.0f, LotSpacing=0.55f, Metric=VoronoiUtils.VoronoiMetric.Manhattan };

    private static BlockParams GetParams(CityDistrict d)
    {
        if (d == null) return DefaultBlockParams;
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
        return DistrictBlockParams.TryGetValue(key, out var p) ? p : DefaultBlockParams;
    }

    // ══════════════════════════════════════════════════════════════════
    // Main entry point
    // ══════════════════════════════════════════════════════════════════

    public CityBlockResult Generate(List<CityDistrict> districts, StreetGraph streetGraph)
    {
        var districtMap = districts.ToDictionary(d => d.Id);
        var nodes       = streetGraph.Nodes;
        var edgesList   = streetGraph.Edges;
        var nodeById    = nodes.ToDictionary(n => n.Id);

        // Edge → districtId lookup (both directions)
        var edgeDistrictByKey = new Dictionary<long, int>();
        foreach (var e in edgesList)
        {
            long k1 = ((long)e.NodeA << 32) | (uint)e.NodeB;
            long k2 = ((long)e.NodeB << 32) | (uint)e.NodeA;
            edgeDistrictByKey[k1] = e.DistrictId;
            edgeDistrictByKey[k2] = e.DistrictId;
        }

        // ── Phase 1: Angle-sorted adjacency for planar face tracing ──
        var adj = new Dictionary<int, List<(int neighbor, float angle)>>();
        foreach (var n in nodes) adj[n.Id] = new();

        foreach (var e in edgesList)
        {
            if (!nodeById.TryGetValue(e.NodeA, out var nA) || !nodeById.TryGetValue(e.NodeB, out var nB)) continue;
            if (e.NodeA == e.NodeB) continue;
            float ang = Mathf.Atan2(nB.Y - nA.Y, nB.X - nA.X);
            adj[e.NodeA].Add((e.NodeB, NormAngle(ang)));
            adj[e.NodeB].Add((e.NodeA, NormAngle(ang + Mathf.PI)));
        }

        foreach (var kv in adj)
        {
            var deduped = kv.Value
                .GroupBy(x => x.neighbor).Select(g => g.First())
                .OrderBy(x => x.angle).ToList();
            adj[kv.Key] = deduped;
        }

        // For half-edge u→v, return next vertex w continuing the same face (rightmost turn at v)
        int? Next(int u, int v)
        {
            if (!adj.TryGetValue(v, out var list) || list.Count == 0) return null;
            int idx = list.FindIndex(nb => nb.neighbor == u);
            if (idx == -1) return null;
            return list[(idx - 1 + list.Count) % list.Count].neighbor;
        }

        // ── Phase 2: Trace faces → blocks ────────────────────────────
        var visited   = new HashSet<long>();
        var blocks    = new List<CityBlock>();
        var buildings = new List<BuildingLot>();
        int blockId = 0, buildingId = 0;

        foreach (var node in nodes)
        {
            foreach (var (nbId, _) in adj.GetValueOrDefault(node.Id) ?? new List<(int, float)>())
            {
                long startKey = ((long)node.Id << 32) | (uint)nbId;
                if (visited.Contains(startKey)) continue;

                var faceNodes   = new List<StreetNode>();
                var faceEdgeKeys = new List<long>();
                int u = node.Id, v = nbId;
                int iters = 0;

                while (true)
                {
                    long hk = ((long)u << 32) | (uint)v;
                    if (visited.Contains(hk) || ++iters > nodes.Count + 5) break;
                    visited.Add(hk);
                    if (nodeById.TryGetValue(u, out var uNode)) faceNodes.Add(uNode);
                    faceEdgeKeys.Add(((long)u << 32) | (uint)v);
                    var w = Next(u, v);
                    if (w == null) break;
                    u = v; v = w.Value;
                }

                if (faceNodes.Count < 3) continue;

                // Shoelace signed area (positive = interior face in y-down / standard screen space)
                float area = 0f;
                for (int i = 0; i < faceNodes.Count; i++)
                {
                    var a2 = faceNodes[i]; var b2 = faceNodes[(i+1) % faceNodes.Count];
                    area += a2.X * b2.Y - b2.X * a2.Y;
                }
                area *= 0.5f;
                if (area <= 0.001f) continue;

                // Majority district vote from half-edges
                var dvotes = new Dictionary<int, int>();
                foreach (var ek in faceEdgeKeys)
                    if (edgeDistrictByKey.TryGetValue(ek, out int dId))
                        dvotes[dId] = dvotes.GetValueOrDefault(dId, 0) + 1;

                int districtId = -1, maxV = 0;
                foreach (var kv2 in dvotes) if (kv2.Value > maxV) { maxV = kv2.Value; districtId = kv2.Key; }

                var verts = faceNodes.Select(fn => new Vector2(fn.X, fn.Y)).ToList();

                var district = districtId >= 0 ? districtMap.GetValueOrDefault(districtId) : null;
                var bp       = GetParams(district);

                float minX = float.MaxValue, maxX = float.MinValue, minY = float.MaxValue, maxY = float.MinValue;
                foreach (var v2 in verts) {
                    if (v2.x<minX) minX=v2.x; if (v2.x>maxX) maxX=v2.x;
                    if (v2.y<minY) minY=v2.y; if (v2.y>maxY) maxY=v2.y;
                }
                float w2 = maxX-minX, h2 = maxY-minY;
                float aspect = Mathf.Max(w2,h2) / Mathf.Max(Mathf.Min(w2,h2), 1e-6f);

                BlockType btype;
                if (area < bp.MinBlockSize || aspect > bp.MaxAspectRatio) btype = BlockType.Square;
                else if (area < bp.MinLotSize)                             btype = BlockType.Single;
                else                                                        btype = BlockType.Subdivided;

                var block = new CityBlock { Id=blockId++, DistrictId=districtId, Vertices=verts, Area=area, Type=btype };
                blocks.Add(block);

                if (btype == BlockType.Square) continue;

                if (btype == BlockType.Single)
                {
                    buildings.Add(new BuildingLot { Id=buildingId++, BlockId=block.Id, DistrictId=districtId, Vertices=new List<Vector2>(verts) });
                    continue;
                }

                // ── Phase 3: Voronoi lot subdivision ─────────────────
                float spacing = bp.LotSpacing;
                var rawSeeds  = new List<Vector2>();
                for (int i = 0; i < verts.Count; i++)
                {
                    var pA = verts[i]; var pB = verts[(i+1)%verts.Count];
                    rawSeeds.Add(pA);
                    float ddx2 = pB.x-pA.x, ddy2 = pB.y-pA.y;
                    float slen = Mathf.Sqrt(ddx2*ddx2+ddy2*ddy2);
                    int steps = Mathf.FloorToInt(slen / spacing);
                    for (int k = 1; k < steps; k++)
                    {
                        float t = k / (float)steps;
                        rawSeeds.Add(new Vector2(pA.x+t*ddx2, pA.y+t*ddy2));
                    }
                }

                float minDist = spacing * 0.4f;
                var dedupSeeds = new List<Vector2>();
                foreach (var rs in rawSeeds)
                    if (!dedupSeeds.Any(e => (rs-e).sqrMagnitude < minDist*minDist))
                        dedupSeeds.Add(rs);

                if (dedupSeeds.Count < 3) continue;

                foreach (var cell in VoronoiUtils.ComputeVoronoiCells(dedupSeeds, verts, bp.Metric))
                    buildings.Add(new BuildingLot { Id=buildingId++, BlockId=block.Id, DistrictId=districtId, Vertices=cell.Polygon });
            }
        }

        int squares = blocks.Count(b => b.Type == BlockType.Square);
        int singles = blocks.Count(b => b.Type == BlockType.Single);
        int subdivs = blocks.Count(b => b.Type == BlockType.Subdivided);
        Debug.Log($"[CityBlockGenerator] {blocks.Count} blocks ({squares} sq, {singles} single, {subdivs} subdiv), {buildings.Count} lots");

        return new CityBlockResult { Blocks = blocks, Buildings = buildings };
    }

    private static float NormAngle(float a)
    {
        while (a >  Mathf.PI) a -= 2f * Mathf.PI;
        while (a <= -Mathf.PI) a += 2f * Mathf.PI;
        return a;
    }
}

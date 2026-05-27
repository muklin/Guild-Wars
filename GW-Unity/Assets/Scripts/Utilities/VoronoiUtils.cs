using System;
using System.Collections.Generic;
using UnityEngine;

/// <summary>
/// Self-contained 2D Delaunay triangulation and Voronoi utilities.
/// All geometry is in the XZ plane (web x → Unity x, web y → Unity z).
/// Use Vector2 for generation; lift to Vector3 at mesh-build time.
/// </summary>
public static class VoronoiUtils
{
    // ══════════════════════════════════════════════════════════════════
    // Data structures
    // ══════════════════════════════════════════════════════════════════

    /// <summary>2-D point. Circumcenter objects are VPoints — keeping them as
    /// reference types means the same object appears in multiple cells' polygon
    /// lists, enabling reference-equality edge detection.</summary>
    public class VPoint
    {
        public float X, Y;
        public int Id = -1;
        public VPoint(float x, float y) { X = x; Y = y; }
        public Vector2 ToV2() => new Vector2(X, Y);
    }

    public class VTriangle
    {
        public VPoint[] Vertices = new VPoint[3];
        /// <summary>Shared reference — same object in every cell whose polygon includes this circumcenter.</summary>
        public VPoint Circumcenter;
        public float RadiusSq;
        public bool Degenerate;

        public VTriangle(VPoint a, VPoint b, VPoint c)
        {
            float cross = (b.X - a.X) * (c.Y - a.Y) - (c.X - a.X) * (b.Y - a.Y);
            if (cross > 0f) { Vertices[0] = a; Vertices[1] = b; Vertices[2] = c; }
            else            { Vertices[0] = a; Vertices[1] = c; Vertices[2] = b; }
            ComputeCircumcircle();
        }

        private void ComputeCircumcircle()
        {
            float ax = Vertices[0].X, ay = Vertices[0].Y;
            float bx = Vertices[1].X, by = Vertices[1].Y;
            float cx = Vertices[2].X, cy = Vertices[2].Y;

            float d = 2f * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
            if (Mathf.Abs(d) < 1e-7f) { Degenerate = true; Circumcenter = new VPoint(0, 0); return; }

            float aa = ax * ax + ay * ay, bb = bx * bx + by * by, cc = cx * cx + cy * cy;
            float ux = (aa * (by - cy) + bb * (cy - ay) + cc * (ay - by)) / d;
            float uy = (aa * (cx - bx) + bb * (ax - cx) + cc * (bx - ax)) / d;

            Circumcenter = new VPoint(ux, uy);
            float dx = ax - ux, dy = ay - uy;
            RadiusSq = dx * dx + dy * dy;
        }

        public bool ContainsInCircumcircle(VPoint p)
        {
            if (Degenerate) return false;
            float dx = p.X - Circumcenter.X, dy = p.Y - Circumcenter.Y;
            return dx * dx + dy * dy < RadiusSq;
        }
    }

    // ══════════════════════════════════════════════════════════════════
    // Bowyer-Watson Delaunay triangulation
    // ══════════════════════════════════════════════════════════════════

    public class TriangulationResult
    {
        public List<VTriangle> Triangles;
        public VPoint[] Points;   // same order as input — only [0..N-1] are real seeds
    }

    /// <summary>
    /// Triangulate the given seed positions. Extra points may be appended to seeds
    /// before calling (e.g. staggered sentinels); pass realCount to indicate how
    /// many of the first entries are "real" (the rest will be filtered during
    /// super-triangle removal but still participate in the triangulation).
    /// </summary>
    public static TriangulationResult Triangulate(List<Vector2> seeds)
    {
        int n = seeds.Count;
        int idCounter = 0;
        var pts = new VPoint[n];
        for (int i = 0; i < n; i++) { pts[i] = new VPoint(seeds[i].x, seeds[i].y); pts[i].Id = idCounter++; }

        float minX = float.MaxValue, maxX = float.MinValue, minY = float.MaxValue, maxY = float.MinValue;
        for (int i = 0; i < n; i++)
        {
            if (pts[i].X < minX) minX = pts[i].X; if (pts[i].X > maxX) maxX = pts[i].X;
            if (pts[i].Y < minY) minY = pts[i].Y; if (pts[i].Y > maxY) maxY = pts[i].Y;
        }

        float dx = Mathf.Max((maxX - minX) * 0.1f, 1f);
        float dy = Mathf.Max((maxY - minY) * 0.1f, 1f);
        var sp1 = new VPoint(minX - dx,              minY - dy * 3f); sp1.Id = idCounter++;
        var sp2 = new VPoint(maxX + dx,              minY - dy * 3f); sp2.Id = idCounter++;
        var sp3 = new VPoint((minX + maxX) * 0.5f,  maxY + dy * 3f); sp3.Id = idCounter++;

        var triangulation = new List<VTriangle> { new VTriangle(sp1, sp2, sp3) };
        var edgeVerts = new Dictionary<long, (VPoint a, VPoint b, int count)>();

        for (int pi = 0; pi < n; pi++)
        {
            var point = pts[pi];
            var badTris = new List<VTriangle>();

            foreach (var tri in triangulation)
                if (tri.ContainsInCircumcircle(point)) badTris.Add(tri);

            edgeVerts.Clear();
            foreach (var tri in badTris)
            {
                for (int ei = 0; ei < 3; ei++)
                {
                    var va = tri.Vertices[ei];
                    var vb = tri.Vertices[(ei + 1) % 3];
                    int lo = Math.Min(va.Id, vb.Id), hi = Math.Max(va.Id, vb.Id);
                    long key = ((long)lo << 32) | (uint)hi;
                    if (edgeVerts.TryGetValue(key, out var existing))
                        edgeVerts[key] = (existing.a, existing.b, existing.count + 1);
                    else
                        edgeVerts[key] = (va, vb, 1);
                }
            }

            foreach (var tri in badTris) triangulation.Remove(tri);

            foreach (var kv in edgeVerts)
            {
                if (kv.Value.count == 1)
                    triangulation.Add(new VTriangle(kv.Value.a, kv.Value.b, point));
            }
        }

        triangulation.RemoveAll(t =>
            t.Vertices[0] == sp1 || t.Vertices[0] == sp2 || t.Vertices[0] == sp3 ||
            t.Vertices[1] == sp1 || t.Vertices[1] == sp2 || t.Vertices[1] == sp3 ||
            t.Vertices[2] == sp1 || t.Vertices[2] == sp2 || t.Vertices[2] == sp3);

        return new TriangulationResult { Triangles = triangulation, Points = pts };
    }

    // ══════════════════════════════════════════════════════════════════
    // Sutherland-Hodgman polygon clipping
    // ══════════════════════════════════════════════════════════════════

    /// <summary>Clip subject polygon against convex clip polygon. Returns null if result has fewer than 3 vertices.</summary>
    public static List<Vector2> ClipToPolygon(List<Vector2> subject, List<Vector2> clip)
    {
        int n = clip.Count;
        float cx = 0f, cy = 0f;
        for (int i = 0; i < n; i++) { cx += clip[i].x; cy += clip[i].y; }
        cx /= n; cy /= n;

        var output = new List<Vector2>(subject);

        for (int i = 0; i < n && output.Count > 0; i++)
        {
            var A = clip[i]; var B = clip[(i + 1) % n];
            float abx = B.x - A.x, aby = B.y - A.y;
            float cSide = abx * (cy - A.y) - aby * (cx - A.x);

            bool Inside(Vector2 p) => (abx * (p.y - A.y) - aby * (p.x - A.x)) * cSide >= 0f;
            Vector2 Intersect(Vector2 P, Vector2 Q)
            {
                float pdx = Q.x - P.x, pdy = Q.y - P.y;
                float denom = abx * pdy - aby * pdx;
                if (Mathf.Abs(denom) < 1e-10f) return P;
                float t = (aby * (P.x - A.x) - abx * (P.y - A.y)) / denom;
                return new Vector2(P.x + t * pdx, P.y + t * pdy);
            }

            var inp = output;
            output = new List<Vector2>(inp.Count);
            for (int j = 0; j < inp.Count; j++)
            {
                var cur = inp[j]; var prev = inp[(j + inp.Count - 1) % inp.Count];
                bool ci = Inside(cur), pi = Inside(prev);
                if (ci) { if (!pi) output.Add(Intersect(prev, cur)); output.Add(cur); }
                else if (pi) output.Add(Intersect(prev, cur));
            }
        }

        return output.Count >= 3 ? output : null;
    }

    // ══════════════════════════════════════════════════════════════════
    // Metric-dependent triangle centre (Voronoi vertex)
    // ══════════════════════════════════════════════════════════════════

    public enum VoronoiMetric { Euclidean, Chebyshev, Manhattan, Centroid }

    public static bool TryTriangleCenter(VTriangle tri, VoronoiMetric metric, out Vector2 result)
    {
        var v0 = tri.Vertices[0]; var v1 = tri.Vertices[1]; var v2 = tri.Vertices[2];
        switch (metric)
        {
            case VoronoiMetric.Euclidean:
                if (tri.Degenerate) { result = default; return false; }
                result = new Vector2(tri.Circumcenter.X, tri.Circumcenter.Y); return true;

            case VoronoiMetric.Centroid:
                result = new Vector2((v0.X + v1.X + v2.X) / 3f, (v0.Y + v1.Y + v2.Y) / 3f); return true;

            case VoronoiMetric.Chebyshev:
            {
                float mnX = Mathf.Min(v0.X, Mathf.Min(v1.X, v2.X)), mxX = Mathf.Max(v0.X, Mathf.Max(v1.X, v2.X));
                float mnY = Mathf.Min(v0.Y, Mathf.Min(v1.Y, v2.Y)), mxY = Mathf.Max(v0.Y, Mathf.Max(v1.Y, v2.Y));
                result = new Vector2((mnX + mxX) * 0.5f, (mnY + mxY) * 0.5f); return true;
            }
            case VoronoiMetric.Manhattan:
            {
                float u0 = v0.X+v0.Y, u1 = v1.X+v1.Y, u2 = v2.X+v2.Y;
                float w0 = v0.X-v0.Y, w1 = v1.X-v1.Y, w2 = v2.X-v2.Y;
                float uc = (Mathf.Min(u0,Mathf.Min(u1,u2)) + Mathf.Max(u0,Mathf.Max(u1,u2))) * 0.5f;
                float vc = (Mathf.Min(w0,Mathf.Min(w1,w2)) + Mathf.Max(w0,Mathf.Max(w1,w2))) * 0.5f;
                result = new Vector2((uc+vc)*0.5f, (uc-vc)*0.5f); return true;
            }
            default: result = default; return false;
        }
    }

    // ══════════════════════════════════════════════════════════════════
    // Grid seed generation (density / jitter / xyRatio)
    // ══════════════════════════════════════════════════════════════════

    public static List<Vector2> GenerateGridSeeds(List<Vector2> polygon, float density,
        float xyRatio = 1f, float jitter = 0.3f, int rngSeed = 0)
    {
        uint s = (uint)(rngSeed * 2654435761);
        float Rng() { s ^= s << 13; s ^= s >> 17; s ^= s << 5; return s / (float)uint.MaxValue; }

        float gdx = Mathf.Sqrt(xyRatio / density);
        float gdy = Mathf.Sqrt(1f / (density * xyRatio));
        float jx = gdx * jitter, jy = gdy * jitter;

        float minX = float.MaxValue, maxX = float.MinValue, minY = float.MaxValue, maxY = float.MinValue;
        foreach (var v in polygon) {
            if (v.x < minX) minX = v.x; if (v.x > maxX) maxX = v.x;
            if (v.y < minY) minY = v.y; if (v.y > maxY) maxY = v.y;
        }

        var seeds = new List<Vector2>();
        for (float gx = minX; gx <= maxX + gdx; gx += gdx)
            for (float gy = minY; gy <= maxY + gdy; gy += gdy)
            {
                float x = gx + (Rng() - 0.5f) * 2f * jx;
                float y = gy + (Rng() - 0.5f) * 2f * jy;
                if (PointInPolygon(x, y, polygon)) seeds.Add(new Vector2(x, y));
            }
        return seeds;
    }

    // ══════════════════════════════════════════════════════════════════
    // Full single-pass Voronoi pipeline (seeds → clipped cells)
    // ══════════════════════════════════════════════════════════════════

    public struct VoronoiCell { public Vector2 SeedPoint; public List<Vector2> Polygon; }

    public static List<VoronoiCell> ComputeVoronoiCells(List<Vector2> seeds,
        List<Vector2> clipPolygon, VoronoiMetric metric = VoronoiMetric.Euclidean)
    {
        var res = Triangulate(seeds);
        var tris = res.Triangles;
        var pts  = res.Points;

        var vertexTris = new Dictionary<int, List<VTriangle>>();
        foreach (var tri in tris)
            for (int i = 0; i < 3; i++)
            {
                int id = tri.Vertices[i].Id;
                if (!vertexTris.TryGetValue(id, out var list)) vertexTris[id] = list = new List<VTriangle>();
                list.Add(tri);
            }

        var cells = new List<VoronoiCell>(seeds.Count);
        for (int i = 0; i < seeds.Count; i++)
        {
            var seed = seeds[i];
            if (!vertexTris.TryGetValue(pts[i].Id, out var ptTris) || ptTris.Count < 3) continue;

            var corners = new List<Vector2>(ptTris.Count);
            foreach (var tri in ptTris)
                if (TryTriangleCenter(tri, metric, out var c)) corners.Add(c);
            if (corners.Count < 3) continue;

            corners.Sort((a, b) =>
                Mathf.Atan2(a.y - seed.y, a.x - seed.x).CompareTo(Mathf.Atan2(b.y - seed.y, b.x - seed.x)));

            var poly = ClipToPolygon(corners, clipPolygon);
            if (poly != null) cells.Add(new VoronoiCell { SeedPoint = seed, Polygon = poly });
        }
        return cells;
    }

    // ══════════════════════════════════════════════════════════════════
    // Geometry helpers
    // ══════════════════════════════════════════════════════════════════

    public static bool PointInPolygon(float px, float py, List<Vector2> polygon)
    {
        bool inside = false;
        int n = polygon.Count;
        for (int i = 0, j = n - 1; i < n; j = i++)
        {
            float xi = polygon[i].x, yi = polygon[i].y, xj = polygon[j].x, yj = polygon[j].y;
            if ((yi > py) != (yj > py) && px < (xj - xi) * (py - yi) / (yj - yi) + xi)
                inside = !inside;
        }
        return inside;
    }

    public static Vector2 ProjectToPolygon(float px, float py, List<Vector2> polygon)
    {
        float best = float.MaxValue; float bx = px, by = py;
        int n = polygon.Count;
        for (int i = 0, j = n - 1; i < n; j = i++)
        {
            float ax = polygon[j].x, ay = polygon[j].y, bpx = polygon[i].x, bpy = polygon[i].y;
            float ddx = bpx - ax, ddy = bpy - ay, lenSq = ddx*ddx + ddy*ddy;
            if (lenSq == 0f) continue;
            float t = Mathf.Clamp01(((px - ax) * ddx + (py - ay) * ddy) / lenSq);
            float cx = ax + t * ddx, cy = ay + t * ddy;
            float d = (px-cx)*(px-cx) + (py-cy)*(py-cy);
            if (d < best) { best = d; bx = cx; by = cy; }
        }
        return new Vector2(bx, by);
    }

    /// <summary>Graham scan convex hull. Returns CCW order.</summary>
    public static List<Vector2> ConvexHull(List<Vector2> points)
    {
        if (points.Count < 3) return new List<Vector2>(points);
        var sorted = new List<Vector2>(points);
        sorted.Sort((a, b) => a.x != b.x ? a.x.CompareTo(b.x) : a.y.CompareTo(b.y));

        static float Cross(Vector2 o, Vector2 a, Vector2 b)
            => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);

        var lower = new List<Vector2>();
        foreach (var p in sorted) {
            while (lower.Count >= 2 && Cross(lower[lower.Count-2], lower[lower.Count-1], p) <= 0)
                lower.RemoveAt(lower.Count-1);
            lower.Add(p);
        }
        var upper = new List<Vector2>();
        for (int i = sorted.Count - 1; i >= 0; i--) {
            var p = sorted[i];
            while (upper.Count >= 2 && Cross(upper[upper.Count-2], upper[upper.Count-1], p) <= 0)
                upper.RemoveAt(upper.Count-1);
            upper.Add(p);
        }
        lower.RemoveAt(lower.Count - 1);
        upper.RemoveAt(upper.Count - 1);
        lower.AddRange(upper);
        return lower;
    }

    /// <summary>Convert List&lt;VPoint&gt; (polygon of circumcenter objects) to List&lt;Vector2&gt;.</summary>
    public static List<Vector2> VPointsToV2(List<VPoint> vpts)
    {
        var result = new List<Vector2>(vpts.Count);
        foreach (var v in vpts) result.Add(new Vector2(v.X, v.Y));
        return result;
    }

    /// <summary>Lift a 2-D polygon to 3-D world space (Y is the flat height).</summary>
    public static List<Vector3> ToVector3(List<Vector2> poly, float y = 0f)
    {
        var result = new List<Vector3>(poly.Count);
        foreach (var v in poly) result.Add(new Vector3(v.x, y, v.y));
        return result;
    }
}

using System.Collections.Generic;
using System.Linq;
using UnityEngine;

namespace DelaunayVoronoi {
    public class DelaunayTriangulator {
        private double MaxX { get; set; }
        private double MaxY { get; set; }
        private IEnumerable<Triangle> Border;
        public List<Point> Points;
        public HashSet<Triangle> Triangulation;
        public IEnumerable<Edge> Edges;
        


        public DelaunayTriangulator(int amount, double maxX, double maxY) {
            GeneratePoints(amount, (double)maxX, (double)maxY);
            BowyerWatson();
            GenerateEdgesFromDelaunay();

        }

        public DelaunayTriangulator(int amount, IEnumerable<Triangle> border) {
            double maxX = 0, maxY = 0, minX = double.PositiveInfinity, minY = double.PositiveInfinity;
            if (border.Count() > 0) {

                foreach (Triangle tri in border) {
                    foreach (Point p in tri.Vertices) {
                        if (p.X < minX) minX = p.X;
                        if (p.Y < minY) minY = p.Y;
                        if (p.X > maxX) maxX = p.X;
                        if (p.Y > maxY) maxY = p.Y;
                    }
                }
                Border = border;

            }
            GeneratePoints(amount, (double)maxX - minX, (double)maxY - minY);
            BowyerWatson();
            GenerateEdgesFromDelaunay();
        }

        public DelaunayTriangulator(List<Point> points) {
            Points = points;
        }

        public void GeneratePoints(int amount, double maxX, double maxY) {
            MaxX = maxX;
            MaxY = maxY;
            List<Point> points;

            // TODO make more beautiful
            var point0 = new Point(0, 0);
            var point1 = new Point(0, MaxY);
            var point2 = new Point(MaxX, MaxY);
            var point3 = new Point(MaxX, 0);
            points = new List<Point>() { point0, point1, point2, point3 };
            var tri1 = new Triangle(point0, point1, point2);
            var tri2 = new Triangle(point0, point2, point3);
            Border = new List<Triangle>() { tri1, tri2 };

            var random = new System.Random();
            for (int i = 0; i < amount - 4; i++) {
                var pointX = random.NextDouble() * MaxX;
                var pointY = random.NextDouble() * MaxY;
                points.Add(new Point(pointX, pointY));
            }
            Points = points;
        }


        public void BowyerWatson() {
            //var supraTriangle = GenerateSupraTriangle();
            HashSet<Triangle> triangulation = new(Border);

            foreach (var point in Points) {
                var badTriangles = FindBadTriangles(point, triangulation);
                var polygon = FindHoleBoundaries(badTriangles);

                foreach (var triangle in badTriangles) {
                    foreach (var vertex in triangle.Vertices) {
                        vertex.AdjacentTriangles.Remove(triangle);
                    }
                }
                triangulation.RemoveWhere(o => badTriangles.Contains(o));

                foreach (var edge in polygon.Where(possibleEdge => possibleEdge.Point1 != point && possibleEdge.Point2 != point)) {
                    var triangle = new Triangle(point, edge.Point1, edge.Point2);
                    triangulation.Add(triangle);
                }
                Triangulation = triangulation;
            }

            //triangulation.RemoveWhere(o => o.Vertices.Any(v => supraTriangle.Vertices.Contains(v)));
        }

        private Triangle GenerateSupraTriangle() {
            //   1  -> maxX
            //  / \
            // 2---3
            // |
            // v maxY
            var margin = 500;
            var point1 = new Point(0.5 * MaxX, -2 * MaxX - margin);
            var point2 = new Point(-2 * MaxY - margin, 2 * MaxY + margin);
            var point3 = new Point(2 * MaxX + MaxY + margin, 2 * MaxY + margin);
            return new Triangle(point1, point2, point3);
        }


        private HashSet<Triangle> FindBadTriangles(Point point, HashSet<Triangle> triangles) {
            var badTriangles = triangles.Where(o => o.IsPointInsideCircumcircle(point));
            return new HashSet<Triangle>(badTriangles);
        }


        private List<Edge> FindHoleBoundaries(HashSet<Triangle> badTriangles) {
            var edges = new List<Edge>();
            foreach (var triangle in badTriangles) {
                edges.Add(new Edge(triangle.Vertices[0], triangle.Vertices[1]));
                edges.Add(new Edge(triangle.Vertices[1], triangle.Vertices[2]));
                edges.Add(new Edge(triangle.Vertices[2], triangle.Vertices[0]));
            }
            var grouped = edges.GroupBy(o => o);
            var boundaryEdges = edges.GroupBy(o => o).Where(o => o.Count() == 1).Select(o => o.First());
            return boundaryEdges.ToList();
        }





        public void GenerateEdgesFromDelaunay() {
            HashSet<Edge> edges = new();
            foreach (var triangle in Triangulation) {
                foreach (var neighbor in triangle.TrianglesWithSharedEdge) {
                    var edge = new Edge(triangle.Circumcenter, neighbor.Circumcenter);
                    edges.Add(edge);
                }
            }
            this.Edges = (HashSet<Edge>)edges.Cast<Edge>();

        }


        public void DrawTris() {
            foreach (Triangle tri in Triangulation) {
                Color color = new(Random.value, Random.value, Random.value);
                foreach (Edge edge in tri.Edges) {
                    Debug.DrawLine(new Vector3((float)edge.Point1.X, 0, (float)edge.Point1.Y), new Vector3((float)edge.Point2.X, 0, (float)edge.Point2.Y), color, 20f);
                }
            }
        }
        public void DrawEdges() {
            Color color = new(Random.value, Random.value, Random.value);
            foreach (Edge edge in Edges) {
                Debug.DrawLine(new Vector3((float)edge.Point1.X, 0, (float)edge.Point1.Y), new Vector3((float)edge.Point2.X, 0, (float)edge.Point2.Y), color, 20f);
            }
        }
    }
}

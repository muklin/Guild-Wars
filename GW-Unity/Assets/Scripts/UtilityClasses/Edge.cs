using System.Numerics;

namespace DelaunayVoronoi
{
    public class Edge {


        public Point Point1 { get; }
        public Point Point2 { get; }
        public Point Centre1 { get; set; }

        public Edge(Point point1, Point point2, Point centre1) {
            Point1 = point1;
            Point2 = point2;
            Centre1 = centre1;
        }

        public Edge(Point point1, Point point2) {
            Point1 = point1;
            Point2 = point2;
        }

        public void setCenter(Point centre1) {
            Centre1 = centre1;
        }

        public override bool Equals(object obj) {
            if (obj == null) return false;
            if (obj.GetType() != GetType()) return false;
            var edge = obj as Edge;

            var samePoints = Point1 == edge.Point1 && Point2 == edge.Point2;
            var samePointsReversed = Point1 == edge.Point2 && Point2 == edge.Point1;
            return samePoints || samePointsReversed;
        }

        public override int GetHashCode(){
            int hCode = (int)Point1.X ^ (int)Point1.Y ^ (int)Point2.X ^ (int)Point2.Y;
            return hCode.GetHashCode();
        }
    }
}

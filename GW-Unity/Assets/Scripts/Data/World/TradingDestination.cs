using System.Linq;

/// <summary>
/// An external (off-map) trade partner. Trading Destinations ARE Factions — they represent
/// outside powers or markets that guilds can build relationships with.
///
/// Inherits Produces / Needs (typed Tradeable lists) from Faction.
/// What the destination Produces = what guilds can import from it.
/// What it Needs = what guilds can export to it.
/// </summary>
public class TradingDestination : Faction
{
    public TradingDestination(string name, string description = "") : base(name)
    {
        Description = description;
    }

    public int        SourceRegionId { get; set; } = -1;
    public List<int>  RoadPath       { get; set; } = new();
    public int        BridgeCount    { get; set; }

    // ==================== CONVENIENCE ACCESSORS ====================

    /// <summary>Names of resources/services this destination exports to guilds.</summary>
    public System.Collections.Generic.List<string> ProducedResourceNames =>
        Produces.Select(p => p.Name).ToList();

    /// <summary>Names of resources/services this destination imports from guilds.</summary>
    public System.Collections.Generic.List<string> ConsumedResourceNames =>
        Needs.Select(n => n.Name).ToList();

    // ==================== ADD HELPERS ====================

    /// <summary>Register a produced item by name (creates a Resource by default).</summary>
    public new void AddProducedResource(string resource) =>
        base.AddProducedResource(resource);

    /// <summary>Register a consumed item by name (creates a Resource by default).</summary>
    public void AddConsumedResource(string resource) =>
        base.AddNeededResource(resource);

    public override string ToString() =>
        $"TradingDest[{Name}, Produces={string.Join(",", ProducedResourceNames)}, Consumes={string.Join(",", ConsumedResourceNames)}]";
}

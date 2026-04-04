using System.Collections.Generic;
using System.Linq;

/// <summary>
/// Base type for all societal actors in GuildWars.
/// Districts, Guilds, TradingDestinations, and ClassFactions are all Factions.
/// A Faction has a list of Tradeables it produces and needs, and a victory threshold
/// for faction-standing win conditions.
/// </summary>
public class Faction
{
    public int Id { get; protected set; }
    public string Name { get; set; }
    public string Description { get; set; }

    // Typed tradeable lists — what this faction produces and what it needs
    public List<Tradeable> Produces { get; protected set; } = new();
    public List<Tradeable> Needs    { get; protected set; } = new();

    // Standing threshold at which a guild wins via faction influence
    public int VictoryThreshold { get; set; } = 90;

    // Standing bonus for a guild whose HQ is in this faction's territory
    public int HQStandingBonus { get; set; } = 20;

    // Auto-assigned IDs start at 100; Guild IDs 1–99 are reserved for explicit assignment
    private static int nextId = 100;

    /// <summary>Auto-assigned ID. Used by Districts, TradingDestinations, ClassFactions.</summary>
    public Faction(string name)
    {
        Id = nextId++;
        Name = name;
    }

    /// <summary>Explicit ID. Used by Guild (IDs 1–99 reserved for player/NPC guilds).</summary>
    protected Faction(int id, string name)
    {
        Id = id;
        Name = name;
    }

    // ==================== TRADEABLES ====================

    public void AddProduced(Tradeable t)
    {
        if (!Produces.Any(p => p.Name == t.Name))
            Produces.Add(t);
    }

    public void AddNeeded(Tradeable t)
    {
        if (!Needs.Any(n => n.Name == t.Name))
            Needs.Add(t);
    }

    /// <summary>Add a Resource to the Produces list by name (creates a Resource instance).</summary>
    public void AddProducedResource(string name)    => AddProduced(new Resource(name));

    /// <summary>Add a Resource to the Needs list by name.</summary>
    public void AddNeededResource(string name)      => AddNeeded(new Resource(name));

    /// <summary>Add a Service to the Produces list by name (creates a Service instance).</summary>
    public void AddProducedService(string name)     => AddProduced(new Service(name));

    /// <summary>Add a Service to the Needs list by name.</summary>
    public void AddNeededService(string name)       => AddNeeded(new Service(name));

    public bool ProducesItem(string name) => Produces.Any(p => p.Name == name);
    public bool NeedsItem(string name)    => Needs.Any(n => n.Name == name);

    public override string ToString() => $"{GetType().Name}[{Name}]";
}

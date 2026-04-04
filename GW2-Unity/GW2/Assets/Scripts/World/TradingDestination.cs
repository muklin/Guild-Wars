using System.Collections.Generic;

/// <summary>
/// An external (off-map) trading partner, defined during Session Zero district setup.
/// Produces resources that guilds can import, and consumes resources guilds can export.
/// </summary>
public class TradingDestination
{
    public int Id { get; private set; }
    public string Name { get; set; }
    public string Description { get; set; }
    public List<string> ProducedResources { get; private set; } = new();
    public List<string> ConsumedResources { get; private set; } = new();

    private static int nextId = 1;

    public TradingDestination(string name, string description = "")
    {
        Id = nextId++;
        Name = name;
        Description = description;
    }

    public void AddProducedResource(string resource)
    {
        if (!ProducedResources.Contains(resource))
            ProducedResources.Add(resource);
    }

    public void AddConsumedResource(string resource)
    {
        if (!ConsumedResources.Contains(resource))
            ConsumedResources.Add(resource);
    }

    public override string ToString() =>
        $"TradingDest[{Name}, Produces={string.Join(",", ProducedResources)}, Consumes={string.Join(",", ConsumedResources)}]";
}

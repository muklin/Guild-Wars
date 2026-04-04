/// <summary>
/// Base class for anything that can be produced, consumed, or traded in GuildWars.
/// Subtypes: Resource (physical goods) and Service (recurring activities).
/// </summary>
public abstract class Tradeable
{
    public int Id { get; private set; }
    public string Name { get; set; }
    public string Description { get; set; }

    private static int nextId = 1;

    protected Tradeable(string name, string description = "")
    {
        Id = nextId++;
        Name = name;
        Description = description;
    }

    public override string ToString() => $"{GetType().Name}[{Name}]";
}

/// <summary>
/// A physical good that can be stockpiled across rounds (e.g. grain, weapons, gold, timber).
/// </summary>
public class Resource : Tradeable
{
    public Resource(string name, string description = "") : base(name, description) { }
}

/// <summary>
/// An ongoing activity or capability that renews each round rather than being stored
/// (e.g. protection, transport, labour, healing, blessings).
/// </summary>
public class Service : Tradeable
{
    public Service(string name, string description = "") : base(name, description) { }
}

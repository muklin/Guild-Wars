using System.Collections.Generic;

/// <summary>
/// Represents a social class or collective group defined during Session Zero.
/// Examples: Upper Classes, Middle Classes, Lower Classes, Bottom Classes, The Church, etc.
/// Class Factions are not tied to a single district — they span the whole city.
/// Guilds gain or lose standing with Class Factions through their actions and choices.
/// </summary>
public class ClassFaction : Faction
{
    /// <summary>Broad social tier this faction belongs to (e.g. "Upper", "Middle", "Lower").</summary>
    public string SocialTier { get; set; }

    /// <summary>Example groups within this class (e.g. "Nobility", "Merchants", "Serfs").</summary>
    public List<string> ExampleGroups { get; private set; } = new();

    public ClassFaction(string name, string socialTier = "") : base(name)
    {
        SocialTier = socialTier;
    }

    public void AddExampleGroup(string group)
    {
        if (!ExampleGroups.Contains(group))
            ExampleGroups.Add(group);
    }

    public override string ToString() => $"ClassFaction[{Name}, Tier={SocialTier}]";
}

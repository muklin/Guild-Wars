/// <summary>
/// A significant threat to the city, placed during Session Zero district setup.
/// Guilds can attempt to mitigate threats through PvE actions.
/// Mitigating a threat earns 3 Round Points and significant faction influence.
/// </summary>
public class Threat
{
    public int Id { get; private set; }
    public string Name { get; set; }
    public string Description { get; set; }
    public int HitPoints { get; set; }
    public int MaxHitPoints { get; set; }
    public int DifficultyClass { get; set; }       // DC for PvE checks
    public string MitigationCriteria { get; set; } // What it takes to resolve the threat
    public string Loot { get; set; }               // Reward description on mitigation
    public int GridX { get; set; } = -1;           // Map position; -1 if off-map
    public int GridZ { get; set; } = -1;
    public bool IsMitigated { get; set; }

    private static int nextId = 1;

    public Threat(string name, string description, int hp, int dc, string mitigationCriteria)
    {
        Id = nextId++;
        Name = name;
        Description = description;
        HitPoints = hp;
        MaxHitPoints = hp;
        DifficultyClass = dc;
        MitigationCriteria = mitigationCriteria;
    }

    public void TakeDamage(int damage)
    {
        HitPoints = System.Math.Max(0, HitPoints - damage);
        if (HitPoints == 0)
            IsMitigated = true;
    }

    public override string ToString() =>
        $"Threat[{Name}, DC={DifficultyClass}, HP={HitPoints}/{MaxHitPoints}, Mitigated={IsMitigated}]";
}

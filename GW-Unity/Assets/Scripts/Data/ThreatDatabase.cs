using UnityEngine;
using System.Collections.Generic;
using System.Linq;

/// <summary>
/// A threat placed on the city map during Session Zero, or spawned as a PvE encounter.
/// Can serve as both a world-map threat (with mitigation criteria) and a PvE combat template.
/// Mitigating a world threat earns 3 Round Points + significant faction influence.
/// </summary>
[System.Serializable]
public class Threat
{
    public int Id;
    public string Name;
    public string Description;
    public int HitPoints;
    public int MaxHitPoints;
    public int Difficulty;          // 1-10, used for DC calculation in PvE
    public int DifficultyClass;     // Explicit DC (overrides Difficulty*2 if set)
    public int GoldReward;
    public string MitigationCriteria; // Session Zero: what it takes to resolve this threat
    public string Loot;               // Reward description on mitigation
    public int GridX = -1;            // Map position; -1 = off-map / no position
    public int GridZ = -1;
    public bool IsMitigated;

    private static int nextId = 1;

    // ── Constructors ─────────────────────────────────────────────────

    /// <summary>PvE template constructor (used by ThreatDatabase).</summary>
    public Threat(int id, string name, int hp, int difficulty, int goldReward)
    {
        Id = id;
        Name = name;
        HitPoints = hp;
        MaxHitPoints = hp;
        Difficulty = difficulty;
        DifficultyClass = difficulty * 2;
        GoldReward = goldReward;
    }

    /// <summary>Session Zero world-threat constructor (auto-assigned ID).</summary>
    public Threat(string name, string description, int hp, int dc, string mitigationCriteria)
    {
        Id = nextId++;
        Name = name;
        Description = description;
        HitPoints = hp;
        MaxHitPoints = hp;
        DifficultyClass = dc;
        Difficulty = dc / 2;
        MitigationCriteria = mitigationCriteria;
    }

    // ── Combat ───────────────────────────────────────────────────────

    public void TakeDamage(int damage)
    {
        HitPoints = System.Math.Max(0, HitPoints - damage);
        if (HitPoints == 0)
            IsMitigated = true;
    }

    public override string ToString() =>
        $"Threat[{Name}, DC={DifficultyClass}, HP={HitPoints}/{MaxHitPoints}, Mitigated={IsMitigated}]";
}

/// <summary>
/// Scriptable Object database of PvE threat templates, configurable in the Editor.
/// </summary>
[CreateAssetMenu(fileName = "ThreatDatabase", menuName = "GuildWars/ThreatDatabase", order = 2)]
public class ThreatDatabase : ScriptableObject
{
    [System.Serializable]
    public class ThreatEntry
    {
        public int Id;
        public string Name;
        public int HitPoints;
        public int Difficulty; // 1-10
        public int GoldReward;
        public string Description;
    }

    [SerializeField]
    private List<ThreatEntry> threats = new();

    private Dictionary<int, Threat> threatCache;

    private void OnEnable() => BuildCache();

    private void BuildCache()
    {
        threatCache = new Dictionary<int, Threat>();
        foreach (var entry in threats)
        {
            threatCache[entry.Id] = new Threat(entry.Id, entry.Name, entry.HitPoints, entry.Difficulty, entry.GoldReward)
            {
                Description = entry.Description
            };
        }
    }

    public Threat GetThreat(int id)
    {
        if (threatCache == null) BuildCache();
        return threatCache.ContainsKey(id) ? threatCache[id] : null;
    }

    public List<Threat> GetAllThreats()
    {
        if (threatCache == null) BuildCache();
        return threatCache.Values.ToList();
    }

    public Threat GetRandomThreat()
    {
        if (threatCache == null || threatCache.Count == 0) return null;
        var list = threatCache.Values.ToList();
        return list[Random.Range(0, list.Count)];
    }

    public Threat GetThreatByDifficulty(int difficulty)
    {
        if (threatCache == null) BuildCache();
        var matching = threatCache.Values.Where(t => t.Difficulty == difficulty).ToList();
        if (matching.Count == 0) return null;
        return matching[Random.Range(0, matching.Count)];
    }

    public void InitializeDefaultThreats()
    {
        if (threats.Count > 0) return;

        threats.Add(new ThreatEntry { Id = 1, Name = "Bandits",     HitPoints = 15, Difficulty = 2, GoldReward = 50,  Description = "A gang of bandits causing trouble in the streets" });
        threats.Add(new ThreatEntry { Id = 2, Name = "Wild Beasts", HitPoints = 20, Difficulty = 3, GoldReward = 75,  Description = "Dangerous creatures attacking travelers" });
        threats.Add(new ThreatEntry { Id = 3, Name = "Dragon",      HitPoints = 50, Difficulty = 8, GoldReward = 300, Description = "A fearsome dragon terrorizing the region" });
        threats.Add(new ThreatEntry { Id = 4, Name = "Plague",      HitPoints = 10, Difficulty = 3, GoldReward = 100, Description = "A disease spreading through the city" });
        threats.Add(new ThreatEntry { Id = 5, Name = "Cult",        HitPoints = 25, Difficulty = 5, GoldReward = 150, Description = "A religious cult operating in secrecy" });
        threats.Add(new ThreatEntry { Id = 6, Name = "Undead",      HitPoints = 30, Difficulty = 6, GoldReward = 200, Description = "Necromantic creatures rising from graves" });

        BuildCache();
    }
}

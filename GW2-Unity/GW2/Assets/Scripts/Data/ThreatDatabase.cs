using UnityEngine;
using System.Collections.Generic;
using System.Linq;

/// <summary>
/// Database of PvE threats for single-player mode.
/// Threats are spawned during district challenges and can be defeated for rewards.
/// </summary>
[System.Serializable]
public class Threat
{
    public int Id;
    public string Name;
    public int HitPoints;
    public int MaxHitPoints;
    public int Difficulty; // 1-10, used for DC calculation
    public int GoldReward;
    public string Description;

    public Threat(int id, string name, int hp, int difficulty, int goldReward)
    {
        Id = id;
        Name = name;
        HitPoints = hp;
        MaxHitPoints = hp;
        Difficulty = difficulty;
        GoldReward = goldReward;
    }
}

/// <summary>
/// Scriptable Object database of threats.
/// Can be extended with more threats via the Editor.
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

    private void OnEnable()
    {
        BuildCache();
    }

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
        if (threatCache == null || threatCache.Count == 0)
        {
            return null;
        }
        var threatList = threatCache.Values.ToList();
        return threatList[Random.Range(0, threatList.Count)];
    }

    public Threat GetThreatByDifficulty(int difficulty)
    {
        if (threatCache == null) BuildCache();
        var matching = threatCache.Values.Where(t => t.Difficulty == difficulty).ToList();
        if (matching.Count == 0) return null;
        return matching[Random.Range(0, matching.Count)];
    }

    /// <summary>
    /// Initialize with default threats if database is empty.
    /// Call this once during game setup.
    /// </summary>
    public void InitializeDefaultThreats()
    {
        if (threats.Count > 0) return;

        threats.Add(new ThreatEntry
        {
            Id = 1,
            Name = "Bandits",
            HitPoints = 15,
            Difficulty = 2,
            GoldReward = 50,
            Description = "A gang of bandits causing trouble in the streets"
        });

        threats.Add(new ThreatEntry
        {
            Id = 2,
            Name = "Wild Beasts",
            HitPoints = 20,
            Difficulty = 3,
            GoldReward = 75,
            Description = "Dangerous creatures attacking travelers"
        });

        threats.Add(new ThreatEntry
        {
            Id = 3,
            Name = "Dragon",
            HitPoints = 50,
            Difficulty = 8,
            GoldReward = 300,
            Description = "A fearsome dragon terrorizing the region"
        });

        threats.Add(new ThreatEntry
        {
            Id = 4,
            Name = "Plague",
            HitPoints = 10,
            Difficulty = 3,
            GoldReward = 100,
            Description = "A disease spreading through the city"
        });

        threats.Add(new ThreatEntry
        {
            Id = 5,
            Name = "Cult",
            HitPoints = 25,
            Difficulty = 5,
            GoldReward = 150,
            Description = "A religious cult operating in secrecy"
        });

        threats.Add(new ThreatEntry
        {
            Id = 6,
            Name = "Undead",
            HitPoints = 30,
            Difficulty = 6,
            GoldReward = 200,
            Description = "Necromantic creatures rising from graves"
        });

        BuildCache();
    }
}

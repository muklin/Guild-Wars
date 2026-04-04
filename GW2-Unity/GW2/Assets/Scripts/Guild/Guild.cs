using System.Collections.Generic;
using System.Linq;
using UnityEngine;

/// <summary>
/// D&D 5e ability types
/// </summary>
public enum Ability
{
    Strength,
    Dexterity,
    Constitution,
    Intelligence,
    Wisdom,
    Charisma
}

/// <summary>
/// Represents a Guild with members, resources, faction standings, and controlled districts.
/// </summary>
public class Guild
{
    public int Id { get; private set; }
    public string Name { get; set; }
    public int OwnerId { get; set; } // Player network ID
    public GuildLeader Leader { get; set; }
    public GuildLeader SecondInCommand { get; set; }

    public List<GuildCharacter> Members { get; private set; } = new();
    public int Gold { get; set; }

    // Faction standings: factionId -> standing (0-100, neutral at 50)
    private Dictionary<int, int> factionStandings = new();

    // Districts this guild controls
    public List<int> ControlledDistrictIds { get; private set; } = new();

    // Resources inventory
    private Dictionary<string, int> resources = new();

    // Squads for action purposes (groups of characters that can take actions)
    public int SquadCount { get; set; } = 1;

    // Session Zero tokens (reset at round start per rules)
    public int VetoTokens { get; set; } = 1;
    public int GuildTokens { get; set; } = 2;
    public int CharacterTokens { get; set; } = 2;
    public int RoundTokens { get; set; } = 2;

    public Guild(int id, string name, int ownerId)
    {
        Id = id;
        Name = name;
        OwnerId = ownerId;
        Gold = 200; // Starting gold per rules
    }

    // ==================== MEMBERS ====================

    public void AddMember(GuildCharacter character)
    {
        if (!Members.Contains(character))
        {
            Members.Add(character);
        }
    }

    public void RemoveMember(GuildCharacter character)
    {
        Members.Remove(character);
    }

    public List<GuildCharacter> GetAvailableMembers()
    {
        return Members.Where(m => !m.IsIncapacitated).ToList();
    }

    // ==================== RESOURCES ====================

    public void AddResource(string resourceType, int amount)
    {
        if (!resources.ContainsKey(resourceType))
            resources[resourceType] = 0;
        resources[resourceType] += amount;
    }

    public bool TryConsumeResource(string resourceType, int amount)
    {
        if (!resources.ContainsKey(resourceType) || resources[resourceType] < amount)
            return false;
        resources[resourceType] -= amount;
        return true;
    }

    public int GetResourceAmount(string resourceType)
    {
        return resources.ContainsKey(resourceType) ? resources[resourceType] : 0;
    }

    public Dictionary<string, int> GetAllResources()
    {
        return new Dictionary<string, int>(resources);
    }

    // ==================== FACTION STANDINGS ====================

    public void UpdateFactionStanding(int factionId, int newStanding)
    {
        factionStandings[factionId] = newStanding;
    }

    public int GetFactionStanding(int factionId)
    {
        return factionStandings.ContainsKey(factionId) ? factionStandings[factionId] : 50;
    }

    public Dictionary<int, int> GetAllFactionStandings()
    {
        return new Dictionary<int, int>(factionStandings);
    }

    // ==================== DISTRICTS ====================

    public void AddControlledDistrict(int districtId)
    {
        if (!ControlledDistrictIds.Contains(districtId))
            ControlledDistrictIds.Add(districtId);
    }

    public void RemoveControlledDistrict(int districtId)
    {
        ControlledDistrictIds.Remove(districtId);
    }

    public bool ControlsDistrict(int districtId)
    {
        return ControlledDistrictIds.Contains(districtId);
    }

    // ==================== MONEY ====================

    public bool TryPayMoney(int amount)
    {
        if (Gold < amount) return false;
        Gold -= amount;
        return true;
    }

    public void ReceiveMoney(int amount)
    {
        Gold += amount;
    }

    public int CalculateSalaryBill()
    {
        // Salary = level * factorial
        // Level 1: 1gp, Level 2: 2gp, Level 3: 6gp, Level 4: 24gp, etc
        return Members.Sum(m => CalculateFactorial(m.Level));
    }

    private int CalculateFactorial(int n)
    {
        int result = 1;
        for (int i = 2; i <= n; i++)
            result *= i;
        return result;
    }

    public override string ToString()
    {
        return $"Guild[{Name}, Members={Members.Count}, Gold={Gold}, Districts={ControlledDistrictIds.Count}]";
    }
}

/// <summary>
/// A character in a guild (player or NPC).
/// </summary>
public class GuildCharacter
{
    public int Id { get; private set; }
    public string Name { get; set; }
    public string Class { get; set; }
    public int Level { get; set; }

    // D&D 5e abilities
    public int Strength { get; set; }
    public int Dexterity { get; set; }
    public int Constitution { get; set; }
    public int Intelligence { get; set; }
    public int Wisdom { get; set; }
    public int Charisma { get; set; }

    // Combat state
    public int HitPoints { get; set; }
    public int MaxHitPoints { get; set; }
    public bool IsIncapacitated { get; set; }

    private static int nextId = 1;

    public GuildCharacter(string name, string charClass, int level)
    {
        Id = nextId++;
        Name = name;
        Class = charClass;
        Level = level;
        MaxHitPoints = 10 + (level - 1) * 5; // Simple formula
        HitPoints = MaxHitPoints;
    }

    public int GetModifier(Ability ability)
    {
        int abilityScore = ability switch
        {
            Ability.Strength => Strength,
            Ability.Dexterity => Dexterity,
            Ability.Constitution => Constitution,
            Ability.Intelligence => Intelligence,
            Ability.Wisdom => Wisdom,
            Ability.Charisma => Charisma,
            _ => 10
        };
        return (abilityScore - 10) / 2;
    }

    public void TakeDamage(int damage)
    {
        HitPoints = Mathf.Max(0, HitPoints - damage);
        IsIncapacitated = HitPoints <= 0;
    }

    public void Heal(int amount)
    {
        HitPoints = Mathf.Min(MaxHitPoints, HitPoints + amount);
        IsIncapacitated = false;
    }

    public override string ToString()
    {
        return $"{Name} - Level {Level} {Class} (HP: {HitPoints}/{MaxHitPoints})";
    }
}

/// <summary>
/// A leader character (special type with additional role).
/// </summary>
public class GuildLeader : GuildCharacter
{
    public string Title { get; set; } = "Leader";

    public GuildLeader(string name, string charClass, int level, string title = "Leader")
        : base(name, charClass, level)
    {
        Title = title;
    }
}

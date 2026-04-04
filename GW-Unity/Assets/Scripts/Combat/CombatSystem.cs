using UnityEngine;

/// <summary>
/// Implements D&D 5e combat rules.
/// Handles attack rolls, damage calculation, and injury states.
/// Uses deterministic seeding for multiplayer synchronization.
/// </summary>
public class CombatSystem
{
    private DiceRoller diceRoller;
    private const int ATTACK_DC = 10; // Base difficulty class for attacks

    public CombatSystem(int seed = 0)
    {
        diceRoller = new DiceRoller(seed);
    }

    // ==================== ATTACK RESOLUTION ====================

    public AttackResult ResolveAttack(GuildCharacter attacker, GuildCharacter defender)
    {
        var result = new AttackResult();

        // Roll attack
        int d20Roll = diceRoller.RollD20();
        int attackModifier = attacker.GetModifier(Ability.Dexterity); // Simplified: assume DEX-based
        int attackRoll = d20Roll + attackModifier;

        result.AttackerName = attacker.Name;
        result.DefenderName = defender.Name;
        result.AttackRoll = attackRoll;
        result.AttackModifier = attackModifier;
        result.D20Roll = d20Roll;

        // Check if hit
        int ac = CalculateAC(defender);
        result.DefenderAC = ac;

        if (attackRoll < ac)
        {
            result.IsHit = false;
            result.Message = $"{attacker.Name} attempts to attack {defender.Name} but misses! (rolled {d20Roll} + {attackModifier})";
            return result;
        }

        // Calculate damage
        int damageRoll = diceRoller.RollD20(); // Simplified: 1d20 damage
        int damageModifier = attacker.GetModifier(Ability.Strength); // Simplified: assume STR-based damage
        int totalDamage = Mathf.Max(1, damageRoll + damageModifier);

        result.IsHit = true;
        result.DamageRoll = damageRoll;
        result.DamageModifier = damageModifier;
        result.TotalDamage = totalDamage;

        // Apply damage
        defender.TakeDamage(totalDamage);
        result.DefenderRemainingHP = defender.HitPoints;
        result.Message = $"{attacker.Name} hits {defender.Name} for {totalDamage} damage! " +
                        $"(HP: {defender.HitPoints}/{defender.MaxHitPoints})";

        if (defender.IsIncapacitated)
            result.Message += $" {defender.Name} is incapacitated!";

        return result;
    }

    // ==================== UTILITY ====================

    private int CalculateAC(GuildCharacter character)
    {
        // Simplified AC calculation: 10 + DEX modifier
        int baseDEX = character.Dexterity;
        int dexModifier = (baseDEX - 10) / 2;
        return 10 + dexModifier;
    }

    public void ApplyDamage(GuildCharacter character, int damage)
    {
        character.TakeDamage(damage);
    }

    public void ApplyHealing(GuildCharacter character, int healing)
    {
        character.Heal(healing);
    }
}

public class AttackResult
{
    public string AttackerName { get; set; }
    public string DefenderName { get; set; }
    public int D20Roll { get; set; }
    public int AttackModifier { get; set; }
    public int AttackRoll { get; set; }
    public int DefenderAC { get; set; }
    public bool IsHit { get; set; }

    public int DamageRoll { get; set; }
    public int DamageModifier { get; set; }
    public int TotalDamage { get; set; }
    public int DefenderRemainingHP { get; set; }

    public string Message { get; set; }

    public override string ToString()
    {
        return Message;
    }
}

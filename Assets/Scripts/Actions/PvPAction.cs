using UnityEngine;

/// <summary>
/// PvP 1v1 Action: Two individual characters duel.
/// Winner receives 1 Round Point.
/// Characters cannot be joined by others during PvP.
/// Characters killed in PvP are not killed but available in next cycle (per rules).
/// Characters can forfeit at any time.
/// </summary>
public class PvPAction : ActionBase
{
    public int AttackerCharacterId { get; set; }
    public int DefenderCharacterId { get; set; }
    public int DefenderGuildId { get; set; }

    private GuildCharacter attacker;
    private GuildCharacter defender;

    public PvPAction(int guildId) : base(guildId)
    {
        Type = ActionType.PvP;
        TargetGuildId = -1;
    }

    public override bool IsValid(GameStateManager gameState)
    {
        var attackingGuild = gameState.GetGuild(InitiatingGuildId);
        var defendingGuild = gameState.GetGuild(DefenderGuildId);

        if (attackingGuild == null || defendingGuild == null)
            return false;

        // Find characters
        attacker = attackingGuild.Members.Find(m => m.Id == AttackerCharacterId);
        defender = defendingGuild.Members.Find(m => m.Id == DefenderCharacterId);

        if (attacker == null || defender == null)
            return false;

        // Both must be available
        if (attacker.IsIncapacitated || defender.IsIncapacitated)
            return false;

        return true;
    }

    public override ActionResult Execute(GameStateManager gameState)
    {
        if (!IsValid(gameState))
            return new ActionResult(false, "PvP action is not valid");

        var result = new ActionResult(true);

        // Combat resolution
        var combatSystem = new CombatSystem();
        int rounds = 0;
        const int maxRounds = 10;

        while (rounds < maxRounds && !attacker.IsIncapacitated && !defender.IsIncapacitated)
        {
            var attackResult = combatSystem.ResolveAttack(attacker, defender);
            Debug.Log(attackResult.Message);

            // Swap sides for next round
            var temp = attacker;
            attacker = defender;
            defender = temp;

            rounds++;
        }

        // Determine winner
        GuildCharacter winner = defender.IsIncapacitated ? attacker : defender;
        GuildCharacter loser = defender.IsIncapacitated ? defender : attacker;

        result.Message = $"PvP combat ended: {winner.Name} defeats {loser.Name}!";
        
        // Winner gets 1 Round Point (handled by action resolver)
        result.FactionStandingChange = 10; // Provisional: +10 standing with local faction

        // Reset both to neutral state (not actually "killed" per rules)
        attacker.Heal(attacker.MaxHitPoints);
        defender.Heal(defender.MaxHitPoints);

        EventSystem.Instance?.Fire(GameEvents.COMBAT_ENDED, result);
        return result;
    }
}

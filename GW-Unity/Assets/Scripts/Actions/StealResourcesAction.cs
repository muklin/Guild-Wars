using UnityEngine;
using System;

/// <summary>
/// Steal Resources Action: Attempt to steal resources from a district.
/// - Uncontrolled district: Automatic success, steal 25-75% of resources
/// - Controlled district: Triggers 1v1 PvP with defending guild's chosen character
/// </summary>
public class StealResourcesAction : ActionBase
{
    public int StealerCharacterId { get; set; } // Character attempting the theft

    public StealResourcesAction(int guildId, int targetDistrictId, int stealerCharacterId) : base(guildId)
    {
        Type = ActionType.ResourceTheft;
        TargetDistrictId = targetDistrictId;
        StealerCharacterId = stealerCharacterId;
    }

    public override bool IsValid(GameStateManager gameState)
    {
        var guild = gameState.GetGuild(InitiatingGuildId);
        var district = gameState.GetDistrict(TargetDistrictId);
        var character = guild?.Members.Find(m => m.Id == StealerCharacterId);

        if (guild == null || district == null || character == null)
            return false;

        // Character must not be incapacitated
        if (character.IsIncapacitated)
            return false;

        return true;
    }

    public override ActionResult Execute(GameStateManager gameState)
    {
        if (!IsValid(gameState))
            return new ActionResult(false, "Cannot execute theft");

        var result = new ActionResult(true);
        var district = gameState.GetDistrict(TargetDistrictId);
        var guild = gameState.GetGuild(InitiatingGuildId);
        var stealer = guild.Members.Find(m => m.Id == StealerCharacterId);

        // If district is uncontrolled, automatic success
        if (!district.IsControlled())
        {
            // Steal 25-75% of district resources (using gold as proxy)
            int stealAmount = UnityEngine.Random.Range(25, 76); // 25-75%
            int goldProduced = district.ProducedResources.ContainsKey("gold") ? district.ProducedResources["gold"] : 0;
            int goldStolen = (int)(goldProduced * stealAmount / 100f);

            guild.ReceiveMoney(goldStolen);
            result.GoldChange = goldStolen;
            result.Message = $"Guild {guild.Name} successfully steals {goldStolen} gold from uncontrolled {district.Name}!";
            result.Success = true;

            EventSystem.Instance?.Fire(GameEvents.ACTION_EXECUTED, result);
            return result;
        }

        // District is controlled - trigger PvP with defender's chosen character
        var controllingGuild = gameState.GetGuild(district.ControllingGuildId);
        if (controllingGuild == null || controllingGuild.Members.Count == 0)
        {
            result.Success = false;
            result.Message = $"Cannot find defending guild for {district.Name}";
            return result;
        }

        // Defender chooses a random available character
        GuildCharacter defender = null;
        foreach (var member in controllingGuild.Members)
        {
            if (!member.IsIncapacitated)
            {
                defender = member;
                break;
            }
        }

        if (defender == null)
        {
            result.Message = $"All defenders in {controllingGuild.Name} are incapacitated! Theft succeeds!";
            int goldProduced = district.ProducedResources.ContainsKey("gold") ? district.ProducedResources["gold"] : 0;
            int goldStolen = (int)(goldProduced * 50 / 100f); // 50% if no defenders
            guild.ReceiveMoney(goldStolen);
            result.GoldChange = goldStolen;
            result.Success = true;
            return result;
        }

        // Run PvP combat
        var combatSystem = new CombatSystem();
        int rounds = 0;
        const int maxRounds = 5;

        GuildCharacter attacker = stealer;
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

        // Determine theft outcome
        if (stealer.IsIncapacitated)
        {
            result.Message = $"Theft failed! {stealer.Name} was defeated by {defender.Name}";
            result.Success = false;
        }
        else
        {
            // Thief wins - steal resources
            int stealAmount = UnityEngine.Random.Range(25, 76); // 25-75%
            int goldProduced = district.ProducedResources.ContainsKey("gold") ? district.ProducedResources["gold"] : 0;
            int goldStolen = (int)(goldProduced * stealAmount / 100f);
            guild.ReceiveMoney(goldStolen);
            result.GoldChange = goldStolen;
            result.Message = $"Theft succeeds! {stealer.Name} defeats {defender.Name} and steals {goldStolen} gold!";
            result.Success = true;
        }

        // Reset characters to full health (not killed per rules)
        stealer.Heal(stealer.MaxHitPoints);
        defender.Heal(defender.MaxHitPoints);

        EventSystem.Instance?.Fire(GameEvents.ACTION_EXECUTED, result);
        return result;
    }
}

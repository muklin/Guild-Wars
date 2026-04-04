using UnityEngine;

/// <summary>
/// District Control Action: Attempt to take control of a district.
/// Requirements:
/// - Guild must have 50+ standing with the district (district IS the faction)
/// - Target district must be adjacent to a district the guild already controls
/// - If district is controlled by another guild, triggers PvP/combat
/// </summary>
public class DistrictControlAction : ActionBase
{
    public new int TargetDistrictId { get; set; }

    public DistrictControlAction(int guildId, int targetDistrictId) : base(guildId)
    {
        Type = ActionType.DistrictControl;
        TargetDistrictId = targetDistrictId;
    }

    public override bool IsValid(GameStateManager gameState)
    {
        var guild = gameState.GetGuild(InitiatingGuildId);
        var district = gameState.GetDistrict(TargetDistrictId);

        if (guild == null || district == null)
            return false;

        // Guild must have 50+ standing with the district (district IS its own faction)
        int standing = guild.GetFactionStanding(district.Id);
        if (standing < 50)
        {
            Debug.Log($"Guild {guild.Name} has {standing} standing with {district.Name}, needs 50+");
            return false;
        }

        // Must be adjacent to a district guild already controls
        bool isAdjacent = false;
        foreach (int controlledDistrictId in guild.ControlledDistrictIds)
        {
            var controlledDistrict = gameState.GetDistrict(controlledDistrictId);
            if (controlledDistrict != null && controlledDistrict.IsAdjacent(TargetDistrictId))
            {
                isAdjacent = true;
                break;
            }
        }

        if (!isAdjacent && guild.ControlledDistrictIds.Count > 0)
        {
            Debug.Log($"Guild {guild.Name} cannot reach district {district.Name}");
            return false;
        }

        return true;
    }

    public override ActionResult Execute(GameStateManager gameState)
    {
        if (!IsValid(gameState))
            return new ActionResult(false, "Cannot control that district");

        var result = new ActionResult(true);
        var district = gameState.GetDistrict(TargetDistrictId);
        var guild = gameState.GetGuild(InitiatingGuildId);

        if (!district.IsControlled())
        {
            // Uncontrolled district — take it and gain faction standing
            gameState.TryTransferDistrict(TargetDistrictId, InitiatingGuildId);
            guild.AddControlledDistrict(TargetDistrictId);
            result.Message = $"Guild {guild.Name} takes control of {district.Name}!";
            result.FactionStandingChange = 10;
        }
        else
        {
            result.Message = $"District {district.Name} is already controlled and would require combat";
            result.Success = false;
        }

        EventSystem.Instance?.Fire(GameEvents.DISTRICT_CONTROL_CHANGED, TargetDistrictId);
        return result;
    }
}

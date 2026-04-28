using UnityEngine;

/// <summary>
/// Guild War Action: Declare war on another guild.
/// Both guilds engage in skirmish battle (all members).
/// Both guilds lose all remaining actions for the round if this passes.
/// </summary>
public class GuildWarAction : ActionBase
{
    public GuildWarAction(int guildId) : base(guildId)
    {
        Type = ActionType.GuildWar;
    }

    public override bool IsValid(GameStateManager gameState)
    {
        // TODO: Validate target guild exists and is not the same as initiating guild
        return TargetGuildId != -1 && gameState.GetGuild(TargetGuildId) != null;
    }

    public override ActionResult Execute(GameStateManager gameState)
    {
        var result = new ActionResult(true, "Guild War declared");
        // TODO: Implement full skirmish battle logic
        return result;
    }
}

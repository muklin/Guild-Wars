/// <summary>
/// Change Leader Action: Replace current guild leader with a different character.
/// This action is submitted secretly to the GM.
/// If new leader is higher level than current leader, this action doesn't cost a squad slot.
/// </summary>
public class ChangeLeaderAction : ActionBase
{
    public int NewLeaderId { get; set; }

    public ChangeLeaderAction(int guildId, int newLeaderId) : base(guildId)
    {
        Type = ActionType.ChangeLeader;
        NewLeaderId = newLeaderId;
    }

    public override bool IsValid(GameStateManager gameState)
    {
        var guild = gameState.GetGuild(InitiatingGuildId);
        if (guild == null) return false;

        var newLeader = guild.Members.Find(m => m.Id == NewLeaderId);
        return newLeader != null && newLeader is GuildLeader;
    }

    public override ActionResult Execute(GameStateManager gameState)
    {
        var guild = gameState.GetGuild(InitiatingGuildId);
        var newLeader = guild.Members.Find(m => m.Id == NewLeaderId) as GuildLeader;

        var oldLeader = guild.Leader;
        guild.Leader = newLeader;

        var result = new ActionResult(true, $"Guild leader changed from {oldLeader.Name} to {newLeader.Name}");
        EventSystem.Instance?.Fire(GameEvents.GUILD_LEADER_CHANGED, guild);
        return result;
    }
}

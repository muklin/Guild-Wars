/// <summary>
/// PvE Action: Attempt action against non-player threats (monsters, puzzles, tasks).
/// Can be contested or uncontested based on action type.
/// May be joined by other guild members or even other guilds.
/// </summary>
public class PvEAction : ActionBase
{
    public string ThreatName { get; set; }
    public int DifficultyClass { get; set; }

    public PvEAction(int guildId, string threatName) : base(guildId)
    {
        Type = ActionType.PvE;
        ThreatName = threatName;
        DifficultyClass = 15; // Default moderate difficulty
    }

    public override bool IsValid(GameStateManager gameState)
    {
        var guild = gameState.GetGuild(InitiatingGuildId);
        return guild != null && guild.Members.Count > 0;
    }

    public override ActionResult Execute(GameStateManager gameState)
    {
        var result = new ActionResult(true, $"PvE action against {ThreatName}");
        // TODO: Implement skill check and threat resolution
        return result;
    }
}

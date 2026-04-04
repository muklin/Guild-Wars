using UnityEngine;

/// <summary>
/// Base class for all guild actions.
/// Actions are submitted during Planning phase and executed in Execution phase.
/// </summary>
public abstract class ActionBase
{
    public int InitiatingGuildId { get; protected set; }
    public int TargetGuildId { get; protected set; } = -1;
    public int TargetDistrictId { get; protected set; } = -1;
    public ActionType Type { get; protected set; }

    public ActionBase(int guildId)
    {
        InitiatingGuildId = guildId;
    }

    /// <summary>
    /// Validates whether this action can be executed.
    /// Called server-side before execution.
    /// </summary>
    public abstract bool IsValid(GameStateManager gameState);

    /// <summary>
    /// Executes the action and returns the result.
    /// </summary>
    public abstract ActionResult Execute(GameStateManager gameState);

    public override string ToString()
    {
        return $"{Type} by Guild {InitiatingGuildId}";
    }
}

public enum ActionType
{
    PvP,
    GuildWar,
    PvE,
    DistrictControl,
    ResourceTheft,
    ChangeLeader
}

public class ActionResult
{
    public bool Success { get; set; }
    public string Message { get; set; }
    public int FactionStandingChange { get; set; } = 0;
    public int GoldChange { get; set; } = 0;

    public ActionResult(bool success, string message = "")
    {
        Success = success;
        Message = message;
    }
}

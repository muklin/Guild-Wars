using System.Collections.Generic;
using System.Linq;
using UnityEngine;

/// <summary>
/// Manages the queue of actions submitted during Planning phase.
/// Validates that guilds don't submit more actions than squads they have.
/// </summary>
public class ActionQueue
{
    private Dictionary<int, List<ActionBase>> queuedActions = new();
    private GameStateManager gameStateManager;

    public ActionQueue(GameStateManager stateManager)
    {
        gameStateManager = stateManager;
    }

    public void Initialize()
    {
        queuedActions.Clear();
        foreach (var guild in gameStateManager.GetAllGuilds())
        {
            queuedActions[guild.Id] = new List<ActionBase>();
        }
    }

    public bool TryEnqueueAction(ActionBase action)
    {
        int guildId = action.InitiatingGuildId;
        var guild = gameStateManager.GetGuild(guildId);

        if (guild == null)
            return false;

        if (!queuedActions.ContainsKey(guildId))
            queuedActions[guildId] = new List<ActionBase>();

        // Check squad limit (1 action per squad)
        if (queuedActions[guildId].Count >= guild.SquadCount)
        {
            Debug.LogWarning($"Guild {guildId} has reached squad action limit ({guild.SquadCount})");
            return false;
        }

        // Validate action
        if (!action.IsValid(gameStateManager))
        {
            Debug.LogWarning($"Action from Guild {guildId} failed validation");
            return false;
        }

        queuedActions[guildId].Add(action);
        EventSystem.Instance?.Fire(GameEvents.ACTION_QUEUED, action);
        return true;
    }

    public List<ActionBase> GetQueuedActions(int guildId)
    {
        return queuedActions.ContainsKey(guildId) ? new List<ActionBase>(queuedActions[guildId]) : new List<ActionBase>();
    }

    public List<ActionBase> GetAllQueuedActions()
    {
        return queuedActions.Values.SelectMany(actions => actions).ToList();
    }

    public void Clear()
    {
        queuedActions.Clear();
    }
}

using System.Collections.Generic;
using UnityEngine;

/// <summary>
/// Executes all queued actions server-side during Execution phase.
/// Handles action validation, execution, faction standing updates.
/// </summary>
public class ActionResolver
{
    private GameStateManager gameStateManager;
    private ActionQueue actionQueue;

    public ActionResolver(GameStateManager stateManager, ActionQueue queue)
    {
        gameStateManager = stateManager;
        actionQueue = queue;
    }

    public List<ActionResult> ExecuteAllActions()
    {
        var results = new List<ActionResult>();
        var allActions = actionQueue.GetAllQueuedActions();

        foreach (var action in allActions)
        {
            Debug.Log($"Executing action: {action}");
            
            // Validate once more before execution
            if (!action.IsValid(gameStateManager))
            {
                var failResult = new ActionResult(false, $"Action {action} failed validation at execution");
                results.Add(failResult);
                EventSystem.Instance?.Fire(GameEvents.ACTION_FAILED, failResult);
                continue;
            }

            // Execute the action
            var result = action.Execute(gameStateManager);
            results.Add(result);

            if (result.Success)
            {
                EventSystem.Instance?.Fire(GameEvents.ACTION_EXECUTED, result);
            }
            else
            {
                EventSystem.Instance?.Fire(GameEvents.ACTION_FAILED, result);
            }

            // Update faction standings if action affected them
            if (result.FactionStandingChange != 0 && action.TargetGuildId != -1)
            {
                // TODO: Update faction standings
            }

            // Update guild gold if action changed it
            var guild = gameStateManager.GetGuild(action.InitiatingGuildId);
            if (guild != null && result.GoldChange != 0)
            {
                guild.ReceiveMoney(result.GoldChange);
            }

            Debug.Log($"Action result: {result.Message}");
        }

        return results;
    }
}

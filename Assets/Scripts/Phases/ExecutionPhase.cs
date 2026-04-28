using UnityEngine;
using System.Collections.Generic;

/// <summary>
/// Execution Phase: All queued actions are executed in order.
/// Combat is resolved, faction standings updated, district control transferred.
/// This phase completes after all actions are executed.
/// </summary>
public class ExecutionPhase : MonoBehaviour, IPhaseHandler
{
    private GameStateManager gameStateManager;
    private GamePhaseManager gamePhaseManager;
    private ActionResolver actionResolver;
    private ActionQueue actionQueue;
    private List<ActionResult> executionResults = new();
    private bool phaseComplete = false;

    public void OnPhaseStart()
    {
        gameStateManager = GameStateManager.Instance;
        gamePhaseManager = GamePhaseManager.Instance;
        phaseComplete = false;
        executionResults.Clear();

        EventSystem.Instance?.Fire(GameEvents.EXECUTION_PHASE_START);

        // Get actions from PlanningPhase
        PlanningPhase planningPhase = (PlanningPhase)gamePhaseManager.GetPhaseHandler(GamePhase.Planning);
        if (planningPhase == null)
        {
            Debug.LogError("Could not retrieve Planning Phase handler");
            phaseComplete = true;
            return;
        }

        // Build ActionQueue from submitted actions
        actionQueue = new ActionQueue(gameStateManager);
        actionQueue.Initialize();

        var allGuilds = gameStateManager.GetAllGuilds();
        foreach (var guild in allGuilds)
        {
            var guildActions = planningPhase.GetSubmittedActions(guild.Id);
            foreach (var action in guildActions)
            {
                actionQueue.TryEnqueueAction(action);
            }
        }

        Debug.Log($"Execution phase: {actionQueue.GetAllQueuedActions().Count} actions queued");

        // Execute all actions
        actionResolver = new ActionResolver(gameStateManager, actionQueue);
        executionResults = actionResolver.ExecuteAllActions();

        phaseComplete = true;
        Debug.Log($"Execution phase: {executionResults.Count} actions executed");
    }

    public void OnPhaseUpdate()
    {
        // Handle real-time action execution here
    }

    public void OnPhaseEnd()
    {
        EventSystem.Instance?.Fire(GameEvents.EXECUTION_PHASE_END);
    }

    public bool IsPhaseComplete()
    {
        return phaseComplete;
    }

    public GamePhase GetPhaseType()
    {
        return GamePhase.Execution;
    }

    // ==================== GETTERS ====================

    public List<ActionResult> GetExecutionResults()
    {
        return new List<ActionResult>(executionResults);
    }
}

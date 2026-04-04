using UnityEngine;
using System.Collections.Generic;

/// <summary>
/// Planning Phase: Players submit actions (1 per squad).
/// Phase waits for timeout or all players to confirm actions.
/// Handles veto voting for invalid actions.
/// For MVP (single-player): Player submits, then NPC opponents generate random actions.
/// </summary>
public class PlanningPhase : MonoBehaviour, IPhaseHandler
{
    private GameStateManager gameStateManager;
    private Dictionary<int, List<ActionBase>> guildActions = new(); // guildId -> list of actions
    private bool allPlayersSubmitted = false;
    private NPCGuildController npcController;
    private float phaseStartTime;

    public void OnPhaseStart()
    {
        gameStateManager = GameStateManager.Instance;
        guildActions.Clear();
        allPlayersSubmitted = false;
        phaseStartTime = Time.time;

        // Initialize NPC controller (single-seed for determinism)
        npcController = new NPCGuildController(gameStateManager, 42);

        EventSystem.Instance?.Fire(GameEvents.PLANNING_PHASE_START);

        // Initialize action collections for each guild
        foreach (var guild in gameStateManager.GetAllGuilds())
        {
            guildActions[guild.Id] = new List<ActionBase>();
        }

        Debug.Log("Planning phase started - waiting for player actions");
    }

    public void OnPhaseUpdate()
    {
        // In single-player MVP: Auto-submit NPC actions after a delay
        // This gives the human player time to think
        if (allPlayersSubmitted == false && Time.time - phaseStartTime > 2f)
        {
            // Check if player (first guild) has submitted an action
            var allGuilds = gameStateManager.GetAllGuilds();
            if (allGuilds.Count > 0 && guildActions[allGuilds[0].Id].Count > 0)
            {
                // Player has submitted - now generate NPC actions
                for (int i = 1; i < allGuilds.Count; i++)
                {
                    var npcActions = npcController.GenerateNPCActions(allGuilds[i].Id);
                    foreach (var action in npcActions)
                    {
                        SubmitAction(allGuilds[i].Id, action);
                    }
                }

                allPlayersSubmitted = true;
                Debug.Log("NPC actions submitted. Ready for execution.");
            }
        }
    }

    public void OnPhaseEnd()
    {
        EventSystem.Instance?.Fire(GameEvents.PLANNING_PHASE_END);
        Debug.Log("Planning phase ended");
    }

    public bool IsPhaseComplete()
    {
        // Phase completes when all players submit or timeout occurs (handled by GamePhaseManager)
        return allPlayersSubmitted;
    }

    public GamePhase GetPhaseType()
    {
        return GamePhase.Planning;
    }

    // ==================== ACTION MANAGEMENT ====================

    public void SubmitAction(int guildId, ActionBase action)
    {
        if (!guildActions.ContainsKey(guildId))
            return;

        // Validate action (1 per squad limit)
        var guild = gameStateManager.GetGuild(guildId);
        if (guild == null) return;

        if (guildActions[guildId].Count >= guild.SquadCount)
        {
            Debug.LogWarning($"Guild {guildId} already submitted {guild.SquadCount} actions");
            return;
        }

        guildActions[guildId].Add(action);
        EventSystem.Instance?.Fire(GameEvents.ACTION_QUEUED, action);
        Debug.Log($"Guild {guildId} submitted action: {action}");
    }

    public List<ActionBase> GetSubmittedActions(int guildId)
    {
        return guildActions.ContainsKey(guildId) ? new List<ActionBase>(guildActions[guildId]) : new List<ActionBase>();
    }

    public void ConfirmAllActionsSubmitted()
    {
        allPlayersSubmitted = true;
    }

    public void ResetActionSubmission()
    {
        guildActions.Clear();
        allPlayersSubmitted = false;
    }
}

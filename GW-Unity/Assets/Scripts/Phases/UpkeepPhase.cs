using UnityEngine;

/// <summary>
/// Upkeep Phase: Distribute resources from controlled districts to guilds.
/// This phase completes automatically and advances to Planning.
/// </summary>
public class UpkeepPhase : MonoBehaviour, IPhaseHandler
{
    private GameStateManager gameStateManager;
    private GuildManager guildManager;
    private bool phaseComplete = false;

    public void OnPhaseStart()
    {
        gameStateManager = GameStateManager.Instance;
        guildManager = new GuildManager(gameStateManager);

        phaseComplete = false;
        EventSystem.Instance?.Fire(GameEvents.UPKEEP_PHASE_START);

        // Distribute resources from all controlled districts
        foreach (var guild in gameStateManager.GetAllGuilds())
        {
            guildManager.DistributeDistrictResources(guild.Id);
        }

        Debug.Log("Upkeep phase: Resources distributed to all guilds");

        // Upkeep completes immediately
        phaseComplete = true;
    }

    public void OnPhaseUpdate()
    {
        // Upkeep does nothing during the update phase
    }

    public void OnPhaseEnd()
    {
        EventSystem.Instance?.Fire(GameEvents.UPKEEP_PHASE_END);
    }

    public bool IsPhaseComplete()
    {
        return phaseComplete;
    }

    public GamePhase GetPhaseType()
    {
        return GamePhase.Upkeep;
    }
}

using UnityEngine;

/// <summary>
/// Bills Phase: Pay district bills and character salaries.
/// Guilds that cannot pay lose control of districts or lose members.
/// </summary>
public class BillsPhase : MonoBehaviour, IPhaseHandler
{
    private GameStateManager gameStateManager;
    private bool phaseComplete = false;

    public void OnPhaseStart()
    {
        gameStateManager = GameStateManager.Instance;
        GuildManager guildManager = new GuildManager(gameStateManager);

        phaseComplete = false;
        EventSystem.Instance?.Fire(GameEvents.BILLS_PHASE_START);

        // Process each guild
        foreach (var guild in gameStateManager.GetAllGuilds())
        {
            // Pay district bills first
            bool districtBillsPaid = guildManager.PayDistrictBills(guild.Id);
            if (!districtBillsPaid)
            {
                Debug.Log($"Guild {guild.Name} lost districts due to unpaid bills");
            }

            // Pay character salaries
            int salaryCost = guildManager.PaySalaries(guild.Id);
            Debug.Log($"Guild {guild.Name} paid {salaryCost}gp in salaries");
        }

        Debug.Log("Bills phase: All bills processed");
        phaseComplete = true;
    }

    public void OnPhaseUpdate()
    {
        // Bills phase has no update logic
    }

    public void OnPhaseEnd()
    {
        EventSystem.Instance?.Fire(GameEvents.BILLS_PHASE_END);
    }

    public bool IsPhaseComplete()
    {
        return phaseComplete;
    }

    public GamePhase GetPhaseType()
    {
        return GamePhase.Bills;
    }
}

using UnityEngine;

/// <summary>
/// Manages the one-time Session Zero setup flow, separate from the repeating game loop.
/// Owns and drives SessionZeroPhase; fires SESSION_ZERO_END when complete, at which point
/// GamePhaseManager takes over with the normal Upkeep → Planning → Execution → Bills cycle.
/// </summary>
public class SessionZeroManager : MonoBehaviour
{
    public static SessionZeroManager Instance { get; private set; }

    private SessionZeroPhase phase;
    private bool completed;

    public SessionZeroPhase Phase => phase;
    public bool IsComplete => completed;

    private void Awake()
    {
        if (Instance != null && Instance != this)
        {
            Destroy(gameObject);
            return;
        }
        Instance = this;
        DontDestroyOnLoad(gameObject);

        phase = gameObject.AddComponent<SessionZeroPhase>();
    }

    private void Update()
    {
        if (completed || phase == null) return;

        phase.OnPhaseUpdate();

        if (phase.IsPhaseComplete())
        {
            completed = true;
            phase.OnPhaseEnd(); // fires SESSION_ZERO_END
        }
    }

    /// <summary>
    /// Starts Session Zero. Call this from GameBootstrapper instead of GamePhaseManager.BeginRound().
    /// </summary>
    public void Begin()
    {
        if (completed)
        {
            Debug.LogWarning("[SessionZeroManager] Session Zero already completed.");
            return;
        }

        GameStateManager.Instance?.SetCurrentPhase(GamePhase.SessionZero);
        phase.OnPhaseStart();
    }
}

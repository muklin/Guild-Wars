using UnityEngine;

/// <summary>
/// Interface for phase handlers.
/// Each phase (Upkeep, Planning, Execution, Bills) implements this interface.
/// </summary>
public interface IPhaseHandler
{
    /// <summary>
    /// Called when the phase starts.
    /// </summary>
    void OnPhaseStart();

    /// <summary>
    /// Called each frame while the phase is active (if time-based).
    /// </summary>
    void OnPhaseUpdate();

    /// <summary>
    /// Called when the phase ends / transitions to next phase.
    /// </summary>
    void OnPhaseEnd();

    /// <summary>
    /// Returns true if the phase is complete and should advance to the next phase.
    /// </summary>
    bool IsPhaseComplete();

    /// <summary>
    /// Returns the GamePhase type this handler manages.
    /// </summary>
    GamePhase GetPhaseType();
}

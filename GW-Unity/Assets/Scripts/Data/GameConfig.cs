using UnityEngine;
using System.Collections.Generic;

/// <summary>
/// Game configuration constants as a Scriptable Object.
/// Centralizes all game balance tuning values.
/// </summary>
[CreateAssetMenu(fileName = "GameConfig", menuName = "GuildWars/GameConfig", order = 1)]
public class GameConfig : ScriptableObject
{
    [Header("Game Rules")]
    [Tooltip("Faction standing needed to win the game")]
    public int VictoryFactionStanding = 90;

    [Tooltip("Starting faction standing (neutral)")]
    public int StartingFactionStanding = 50;

    [Tooltip("Minimum faction standing to interact with district")]
    public int MinimumFactionStandingToControl = 50;

    [Header("Round Durations (in real-world time for testing, change for production)")]
    [Tooltip("Duration of Round 1 in seconds (test: 5-10, production: 1 month)")]
    public float Round1DurationSeconds = 10f;

    [Tooltip("Duration of Round 2 in seconds")]
    public float Round2DurationSeconds = 20f;

    [Tooltip("Duration of Round 3 in seconds")]
    public float Round3DurationSeconds = 30f;

    [Header("Phase Durations")]
    [Tooltip("Planning phase timeout in seconds")]
    public float PlanningPhaseDurationSeconds = 30f;

    [Tooltip("Execution phase display delay per action in seconds")]
    public float ExecutionActionDelaySeconds = 2f;

    [Header("Resource System")]
    [Tooltip("Base salary per character level per month")]
    public int BaseSalaryPerLevel = 1;

    [Tooltip("District bill payment multiplier")]
    public float DistrictBillMultiplier = 1f;

    [Header("Combat")]
    [Tooltip("Base attack DC for combat")]
    public int AttackDC = 10;

    [Tooltip("Max combat rounds per PvP action")]
    public int MaxCombatRounds = 10;

    [Tooltip("Max combat rounds for theft encounter")]
    public int MaxTheftCombatRounds = 5;

    [Header("Actions")]
    [Tooltip("Faction standing bonus for successful district control")]
    public int DistrictControlFactionBonus = 10;

    [Tooltip("Faction standing bonus for PvP victory")]
    public int PvPVictoryFactionBonus = 5;

    [Tooltip("Min percent of resources stolen in theft")]
    public int TheftMinPercentage = 25;

    [Tooltip("Max percent of resources stolen in theft")]
    public int TheftMaxPercentage = 75;

    [Header("NPC AI")]
    [Tooltip("Probability of NPC choosing PvP action (0-100)")]
    public int NPCPvPProbability = 50;

    [Tooltip("Probability of NPC choosing District Control action (0-100)")]
    public int NPCDistrictControlProbability = 30;

    [Tooltip("Probability of NPC choosing Steal Resources action (0-100)")]
    public int NPCStealProbability = 20;

    /// <summary>
    /// Calculate salary for a character by level using factorial formula.
    /// Level 1 = 1gp, Level 2 = 2gp, Level 3 = 6gp, Level 4 = 24gp, etc.
    /// </summary>
    public int GetCharacterSalary(int level)
    {
        if (level <= 0) return 0;
        int factorial = 1;
        for (int i = 2; i <= level; i++)
        {
            factorial *= i;
        }
        return factorial * BaseSalaryPerLevel;
    }

    /// <summary>
    /// Get the duration of the specified round in seconds.
    /// </summary>
    public float GetRoundDuration(int roundNumber)
    {
        return roundNumber switch
        {
            1 => Round1DurationSeconds,
            2 => Round2DurationSeconds,
            3 => Round3DurationSeconds,
            _ => 60f // Default fallback
        };
    }
}

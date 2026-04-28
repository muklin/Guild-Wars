using UnityEngine;

/// <summary>
/// Deterministic random number generator for multiplayer synchronization.
/// Using a seeded random ensures both server and clients get the same results.
/// </summary>
public class DiceRoller
{
    private System.Random random;

    public DiceRoller(int seed = 0)
    {
        if (seed == 0)
            seed = System.DateTime.Now.GetHashCode();
        random = new System.Random(seed);
    }

    /// <summary>
    /// Rolls a d20 (1-20)
    /// </summary>
    public int RollD20()
    {
        return random.Next(1, 21);
    }

    /// <summary>
    /// Rolls a dX (1-X)
    /// </summary>
    public int RollDX(int sides)
    {
        return random.Next(1, sides + 1);
    }

    /// <summary>
    /// Rolls multiple dice (e.g., 3d6)
    /// </summary>
    public int RollMultiple(int numDice, int sidesPerDie)
    {
        int total = 0;
        for (int i = 0; i < numDice; i++)
            total += RollDX(sidesPerDie);
        return total;
    }
}

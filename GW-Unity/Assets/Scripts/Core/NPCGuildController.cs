using UnityEngine;
using System.Collections.Generic;
using System.Linq;

/// <summary>
/// Controls NPC Guild AI for single-player mode.
/// Generates random valid actions for NPC opponents.
/// For MVP: Simple random action selection (no complex strategy).
/// </summary>
public class NPCGuildController
{
    private GameStateManager gameStateManager;
    private System.Random random;

    public NPCGuildController(GameStateManager stateManager, int seed = 0)
    {
        gameStateManager = stateManager;
        random = new System.Random(seed);
    }

    /// <summary>
    /// Generate random actions for all NPC guilds.
    /// Call this after the human player submits their action during Planning phase.
    /// </summary>
    public List<ActionBase> GenerateNPCActions(int npcGuildId)
    {
        var npcGuild = gameStateManager.GetGuild(npcGuildId);
        if (npcGuild == null)
            return new List<ActionBase>();

        var actions = new List<ActionBase>();

        // Generate 1 action per squad (same rule as human player)
        for (int i = 0; i < npcGuild.SquadCount; i++)
        {
            var action = GenerateSingleAction(npcGuild);
            if (action != null)
            {
                actions.Add(action);
            }
        }

        return actions;
    }

    private ActionBase GenerateSingleAction(Guild npcGuild)
    {
        // List of available guilds (filter out self and non-NPC guilds if needed)
        var otherGuilds = gameStateManager.GetAllGuilds()
            .Where(g => g.Id != npcGuild.Id && g.Members.Count > 0)
            .ToList();

        if (otherGuilds.Count == 0)
            return null;

        // Random action type: PvP (50%), DistrictControl (30%), Steal (20%)
        int actionRoll = random.Next(100);
        ActionBase action = null;

        if (actionRoll < 50 && otherGuilds.Count > 0)
        {
            // PvP Action
            action = GeneratePvPAction(npcGuild, otherGuilds);
        }
        else if (actionRoll < 80)
        {
            // District Control Action
            action = GenerateDistrictControlAction(npcGuild);
        }
        else
        {
            // Steal Resources Action
            action = GenerateStealAction(npcGuild);
        }

        return action;
    }

    private ActionBase GeneratePvPAction(Guild attacker, List<Guild> defenders)
    {
        if (defenders.Count == 0 || attacker.Members.Count == 0)
            return null;

        // Pick random defender guild
        var defenderGuild = defenders[random.Next(defenders.Count)];

        // Pick random attacker character
        var attackerChar = attacker.Members[random.Next(attacker.Members.Count)];

        // Pick random defender character
        var defenderChar = defenderGuild.Members[random.Next(defenderGuild.Members.Count)];

        var action = new PvPAction(attacker.Id)
        {
            AttackerCharacterId = attackerChar.Id,
            DefenderCharacterId = defenderChar.Id,
            DefenderGuildId = defenderGuild.Id
        };

        return action;
    }

    private ActionBase GenerateDistrictControlAction(Guild guild)
    {
        // Find all uncontrolled districts or adjacent districts
        var allDistricts = gameStateManager.GetAllDistricts();
        var targetDistricts = new List<District>();

        foreach (var district in allDistricts)
        {
            // Check if district is uncontrolled or adjacency allows claiming
            if (!district.IsControlled())
            {
                targetDistricts.Add(district);
            }
            else if (guild.ControlledDistrictIds.Count > 0)
            {
                // Check if adjacent to controlled district
                foreach (int controlledId in guild.ControlledDistrictIds)
                {
                    if (district.IsAdjacent(controlledId))
                    {
                        targetDistricts.Add(district);
                        break;
                    }
                }
            }
        }

        if (targetDistricts.Count == 0)
            return null;

        var target = targetDistricts[random.Next(targetDistricts.Count)];
        return new DistrictControlAction(guild.Id, target.Id);
    }

    private ActionBase GenerateStealAction(Guild guild)
    {
        if (guild.Members.Count == 0)
            return null;

        // Pick random thief character
        var thief = guild.Members[random.Next(guild.Members.Count)];

        // Pick random district to target
        var allDistricts = gameStateManager.GetAllDistricts();
        if (allDistricts.Count == 0)
            return null;

        var targetDistrict = allDistricts[random.Next(allDistricts.Count)];
        return new StealResourcesAction(guild.Id, targetDistrict.Id, thief.Id);
    }
}

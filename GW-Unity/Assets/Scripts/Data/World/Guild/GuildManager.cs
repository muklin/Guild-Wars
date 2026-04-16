using UnityEngine;
using System.Collections.Generic;
using System.Linq;

/// <summary>
/// Manager for all guild-related operations.
/// Handles roster updates, salary calculations, resource transfers, etc.
/// </summary>
public class GuildManager
{
    private GameStateManager gameStateManager;

    public GuildManager(GameStateManager stateManager)
    {
        gameStateManager = stateManager;
    }

    // ==================== MEMBER MANAGEMENT ====================

    public void AddMemberToGuild(int guildId, GuildCharacter character)
    {
        var guild = gameStateManager.GetGuild(guildId);
        if (guild != null)
        {
            guild.AddMember(character);
            EventSystem.Instance?.Fire(GameEvents.GUILD_MEMBER_ADDED, guild);
        }
    }

    public void RemoveMemberFromGuild(int guildId, GuildCharacter character)
    {
        var guild = gameStateManager.GetGuild(guildId);
        if (guild != null)
        {
            guild.RemoveMember(character);
            EventSystem.Instance?.Fire(GameEvents.GUILD_MEMBER_REMOVED, guild);
        }
    }

    /// <summary>
    /// Attempts to pay salaries for all guild members.
    /// Members that cannot be paid are removed from the guild.
    /// </summary>
    public int PaySalaries(int guildId)
    {
        var guild = gameStateManager.GetGuild(guildId);
        if (guild == null) return 0;

        int totalSalaryCost = guild.CalculateSalaryBill();

        if (guild.TryPayMoney(totalSalaryCost))
            return totalSalaryCost;

        // Not enough money - remove members starting from lowest level
        var membersToRemove = guild.Members
            .OrderBy(m => m.Level)
            .ToList();

        foreach (var member in membersToRemove)
        {
            guild.RemoveMember(member);
            int salaryCost = Factorial(member.Level);

            if (guild.TryPayMoney(salaryCost))
                continue;

            // Still not enough - refund and stop
            guild.ReceiveMoney(salaryCost);
            guild.AddMember(member); // Add back
            break;
        }

        return totalSalaryCost;
    }

    /// <summary>
    /// Transfers gold between guilds (e.g., tribute, trade).
    /// </summary>
    public bool TransferGold(int fromGuildId, int toGuildId, int amount)
    {
        var fromGuild = gameStateManager.GetGuild(fromGuildId);
        var toGuild = gameStateManager.GetGuild(toGuildId);

        if (fromGuild == null || toGuild == null) return false;

        if (!fromGuild.TryPayMoney(amount)) return false;

        toGuild.ReceiveMoney(amount);
        return true;
    }

    /// <summary>
    /// Transfers resources between guilds.
    /// </summary>
    public bool TransferResource(int fromGuildId, int toGuildId, string resourceType, int amount)
    {
        var fromGuild = gameStateManager.GetGuild(fromGuildId);
        var toGuild = gameStateManager.GetGuild(toGuildId);

        if (fromGuild == null || toGuild == null) return false;

        if (!fromGuild.TryConsumeResource(resourceType, amount)) return false;

        toGuild.AddResource(resourceType, amount);
        return true;
    }

    /// <summary>
    /// Distributes resources from controlled districts to the guild.
    /// </summary>
    public void DistributeDistrictResources(int guildId)
    {
        var guild = gameStateManager.GetGuild(guildId);
        if (guild == null) return;

        foreach (int districtId in guild.ControlledDistrictIds)
        {
            var district = gameStateManager.GetDistrict(districtId);
            if (district == null) continue;

            var generatedResources = district.GenerateResources();
            foreach (var kvp in generatedResources)
            {
                guild.AddResource(kvp.Key, kvp.Value);
            }
        }
    }

    /// <summary>
    /// Attempts to pay district bills with controlled districts.
    /// Returns true if all bills paid; false if guild loses control of some districts.
    /// </summary>
    public bool PayDistrictBills(int guildId)
    {
        var guild = gameStateManager.GetGuild(guildId);
        if (guild == null) return true;

        var districtsToLoose = new List<int>();

        foreach (int districtId in guild.ControlledDistrictIds)
        {
            var district = gameStateManager.GetDistrict(districtId);
            if (district == null) continue;

            var requiredResources = district.GetRequiredResources();
            bool canPayBill = true;

            // Check if guild can pay
            foreach (var kvp in requiredResources)
            {
                if (guild.GetResourceAmount(kvp.Key) < kvp.Value)
                {
                    canPayBill = false;
                    break;
                }
            }

            if (!canPayBill)
            {
                // Try to pay with the district's generated resources
                var generatedResources = district.GenerateResources();
                bool canPayWithGenerated = true;

                foreach (var kvp in requiredResources)
                {
                    if (!generatedResources.ContainsKey(kvp.Key) || generatedResources[kvp.Key] < kvp.Value)
                    {
                        canPayWithGenerated = false;
                        break;
                    }
                }

                if (!canPayWithGenerated)
                {
                    districtsToLoose.Add(districtId);
                }
            }

            // Consume resources
            foreach (var kvp in requiredResources)
            {
                guild.TryConsumeResource(kvp.Key, kvp.Value);
            }
        }

        // Lose control of unpaid districts
        foreach (int districtId in districtsToLoose)
        {
            gameStateManager.TryTransferDistrict(districtId, -1);
            guild.RemoveControlledDistrict(districtId);
        }

        return districtsToLoose.Count == 0;
    }

    // ==================== UTILITY ====================

    private int Factorial(int n)
    {
        int result = 1;
        for (int i = 2; i <= n; i++)
            result *= i;
        return result;
    }
}

using UnityEngine;
using System.Collections.Generic;

/// <summary>
/// Validates that the MVP game setup is correct.
/// Checks for required components, 3 guilds, UI panels, etc.
/// Useful for debugging setup issues.
/// </summary>
public class GameSetupValidator : MonoBehaviour
{
    public void ValidateSetup()
    {
        Debug.Log("=== MVP Game Setup Validation ===");

        bool allValid = true;

        // Check GameStateManager
        var gameStateManager = GameStateManager.Instance;
        if (gameStateManager == null)
        {
            Debug.LogError("✗ GameStateManager not found!");
            allValid = false;
        }
        else
        {
            Debug.Log("✓ GameStateManager initialized");
        }

        // Check EventSystem
        var eventSystem = EventSystem.Instance;
        if (eventSystem == null)
        {
            Debug.LogError("✗ EventSystem not found!");
            allValid = false;
        }
        else
        {
            Debug.Log("✓ EventSystem initialized");
        }

        // Check GamePhaseManager
        var gamePhaseManager = GamePhaseManager.Instance;
        if (gamePhaseManager == null)
        {
            Debug.LogError("✗ GamePhaseManager not found!");
            allValid = false;
        }
        else
        {
            Debug.Log("✓ GamePhaseManager initialized");
        }

        // Check UIManager
        var uiManager = UIManager.Instance;
        if (uiManager == null)
        {
            Debug.LogError("✗ UIManager not found!");
            allValid = false;
        }
        else
        {
            Debug.Log("✓ UIManager initialized");
        }

        // Check guilds (should be exactly 3 for MVP: 1 player + 2 NPCs)
        if (gameStateManager != null)
        {
            var guilds = gameStateManager.GetAllGuilds();
            if (guilds.Count != 3)
            {
                Debug.LogError($"✗ Expected 3 guilds (1 player + 2 NPCs), found {guilds.Count}");
                allValid = false;
            }
            else
            {
                Debug.Log($"✓ Found {guilds.Count} guilds:");
                foreach (var guild in guilds)
                {
                    Debug.Log($"  - {guild.Name} (ID: {guild.Id}, Members: {guild.Members.Count}, Gold: {guild.Gold}gp)");
                }
            }

            // Check districts
            var districts = gameStateManager.GetAllDistricts();
            Debug.Log($"✓ Found {districts.Count} districts:");
            foreach (var district in districts)
            {
                string controller = district.IsControlled() ? gameStateManager.GetGuild(district.ControllingGuildId)?.Name : "Uncontrolled";
                Debug.Log($"  - {district.Name} (Controlled by: {controller})");
            }

            // Check factions
            var factions = gameStateManager.GetAllFactions();
            Debug.Log($"✓ Found {factions.Count} factions:");
            foreach (var faction in factions)
            {
                Debug.Log($"  - {faction.Name}");
            }

            // Check current phase
            var currentPhase = gameStateManager.GetCurrentPhase();
            Debug.Log($"✓ Current phase: {currentPhase}");

            // Check current round
            var currentRound = gameStateManager.GetCurrentRound();
            Debug.Log($"✓ Current round: {currentRound}");
        }

        if (allValid)
        {
            Debug.Log("=== ✓ MVP Setup Validation PASSED ===");
        }
        else
        {
            Debug.LogError("=== ✗ MVP Setup Validation FAILED ===");
        }
    }

    private void Start()
    {
        // Validate on startup
        Invoke("ValidateSetup", 0.5f);
    }
}

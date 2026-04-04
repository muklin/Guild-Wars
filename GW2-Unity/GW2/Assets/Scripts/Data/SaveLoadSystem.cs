using UnityEngine;
using System.Collections.Generic;
using System.IO;

/// <summary>
/// Handles saving and loading game state to JSON files.
/// Includes per-round save points for rollback capability.
/// </summary>
public class SaveLoadSystem
{
    private string savePath;
    private const string SAVE_FOLDER = "Saves";

    public SaveLoadSystem()
    {
        savePath = Path.Combine(Application.persistentDataPath, SAVE_FOLDER);
        if (!Directory.Exists(savePath))
        {
            Directory.CreateDirectory(savePath);
        }
    }

    /// <summary>
    /// Save complete game state to JSON file.
    /// </summary>
    public bool SaveGame(string fileName, GameStateManager gameState)
    {
        try
        {
            var saveData = new GameSaveData
            {
                CurrentRound = gameState.GetCurrentRound(),
                CurrentPhaseString = gameState.GetCurrentPhase().ToString(),
                Timestamp = System.DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss"),
                Guilds = SerializeGuilds(gameState.GetAllGuilds()),
                Districts = SerializeDistricts(gameState.GetAllDistricts()),
                Factions = SerializeFactions(gameState.GetAllFactions())
            };

            string json = JsonUtility.ToJson(saveData, true);
            string filePath = Path.Combine(savePath, fileName + ".json");
            File.WriteAllText(filePath, json);

            Debug.Log($"Game saved to {filePath}");
            return true;
        }
        catch (System.Exception e)
        {
            Debug.LogError($"Failed to save game: {e.Message}");
            return false;
        }
    }

    /// <summary>
    /// Load game state from JSON file.
    /// </summary>
    public GameSaveData LoadGame(string fileName)
    {
        try
        {
            string filePath = Path.Combine(savePath, fileName + ".json");
            if (!File.Exists(filePath))
            {
                Debug.LogWarning($"Save file not found: {filePath}");
                return null;
            }

            string json = File.ReadAllText(filePath);
            GameSaveData data = JsonUtility.FromJson<GameSaveData>(json);

            Debug.Log($"Game loaded from {filePath}");
            return data;
        }
        catch (System.Exception e)
        {
            Debug.LogError($"Failed to load game: {e.Message}");
            return null;
        }
    }

    /// <summary>
    /// Get list of available save files.
    /// </summary>
    public List<string> GetSaveFiles()
    {
        var saves = new List<string>();
        if (Directory.Exists(savePath))
        {
            string[] files = Directory.GetFiles(savePath, "*.json");
            foreach (string file in files)
            {
                saves.Add(Path.GetFileNameWithoutExtension(file));
            }
        }
        return saves;
    }

    private List<GuildSaveData> SerializeGuilds(List<Guild> guilds)
    {
        var data = new List<GuildSaveData>();
        foreach (var guild in guilds)
        {
            data.Add(new GuildSaveData
            {
                Id = guild.Id,
                Name = guild.Name,
                Gold = guild.Gold,
                SquadCount = guild.SquadCount,
                ControlledDistrictIds = new List<int>(guild.ControlledDistrictIds),
                Members = SerializeCharacters(guild.Members),
                FactionStandings = SerializeFactionStandings(guild)
            });
        }
        return data;
    }

    private List<GuildCharacterSaveData> SerializeCharacters(List<GuildCharacter> characters)
    {
        var data = new List<GuildCharacterSaveData>();
        foreach (var character in characters)
        {
            data.Add(new GuildCharacterSaveData
            {
                Id = character.Id,
                Name = character.Name,
                Level = character.Level,
                HitPoints = character.HitPoints,
                MaxHitPoints = character.MaxHitPoints,
                Strength = character.Strength,
                Dexterity = character.Dexterity,
                Constitution = character.Constitution,
                IsIncapacitated = character.IsIncapacitated
            });
        }
        return data;
    }

    private List<FactionStandingSaveData> SerializeFactionStandings(Guild guild)
    {
        var data = new List<FactionStandingSaveData>();
        var gameStateManager = Object.FindAnyObjectByType<GameStateManager>();
        if (gameStateManager != null)
        {
            var factions = gameStateManager.GetAllFactions();
            foreach (var faction in factions)
            {
                data.Add(new FactionStandingSaveData
                {
                    FactionId = faction.Id,
                    Standing = guild.GetFactionStanding(faction.Id)
                });
            }
        }
        return data;
    }

    private List<DistrictSaveData> SerializeDistricts(List<District> districts)
    {
        var data = new List<DistrictSaveData>();
        foreach (var district in districts)
        {
            int goldProduction = district.ProducedResources.ContainsKey("gold") ? district.ProducedResources["gold"] : 0;
            data.Add(new DistrictSaveData
            {
                Id = district.Id,
                Name = district.Name,
                ControlledByGuildId = district.ControllingGuildId,
                GoldProduction = goldProduction
            });
        }
        return data;
    }

    private List<FactionSaveData> SerializeFactions(List<Faction> factions)
    {
        var data = new List<FactionSaveData>();
        foreach (var faction in factions)
        {
            data.Add(new FactionSaveData
            {
                Id = faction.Id,
                Name = faction.Name
            });
        }
        return data;
    }
}

/// <summary>
/// Data container for complete game save state.
/// </summary>
[System.Serializable]
public class GameSaveData
{
    public int CurrentRound;
    public string CurrentPhaseString;
    public string Timestamp;
    public List<GuildSaveData> Guilds;
    public List<DistrictSaveData> Districts;
    public List<FactionSaveData> Factions;
}

[System.Serializable]
public class GuildSaveData
{
    public int Id;
    public string Name;
    public int Gold;
    public int SquadCount;
    public List<int> ControlledDistrictIds;
    public List<GuildCharacterSaveData> Members;
    public List<FactionStandingSaveData> FactionStandings;
}

[System.Serializable]
public class GuildCharacterSaveData
{
    public int Id;
    public string Name;
    public int Level;
    public int HitPoints;
    public int MaxHitPoints;
    public int Strength;
    public int Dexterity;
    public int Constitution;
    public bool IsIncapacitated;
}

[System.Serializable]
public class FactionStandingSaveData
{
    public int FactionId;
    public int Standing;
}

[System.Serializable]
public class DistrictSaveData
{
    public int Id;
    public string Name;
    public int ControlledByGuildId;
    public int GoldProduction;
}

[System.Serializable]
public class FactionSaveData
{
    public int Id;
    public string Name;
}

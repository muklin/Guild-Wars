using UnityEngine;
using System.Collections.Generic;
using System.Linq;

public class GameStateManager : MonoBehaviour
{
    public static GameStateManager Instance { get; private set; }
    private EventSystem eventSystem;

    [System.Serializable]
    public class GameState
    {
        public List<Guild> Guilds = new();
        public List<District> Districts = new();
        public List<Faction> Factions = new();
        public List<Threat> Threats = new();
        public List<TradingDestination> TradingDestinations = new();
        public string CityLeaderName = "";
        public string CitySuccessionMethod = "";
        public int CurrentRound = 1;
        public string CurrentPhase = "Upkeep";
        public int TurnCount = 0;
    }

    private GameState state = new();

    private void Awake()
    {
        if (Instance != null && Instance != this)
        {
            Destroy(gameObject);
            return;
        }
        Instance = this;
        DontDestroyOnLoad(gameObject);
        eventSystem = EventSystem.Instance;
    }

    public void InitializeGame(List<Guild> guilds, List<District> districts, List<Faction> factions)
    {
        state.Guilds = guilds;
        state.Districts = districts;
        state.Factions = factions;
        state.CurrentRound = 1;
        state.CurrentPhase = "Upkeep";
        state.TurnCount = 0;
        EventSystem.Instance?.Fire(GameEvents.GAME_STARTED);
        Debug.Log($"[GameStateManager] Game initialized");
    }

    public Guild GetGuild(int guildId) => state.Guilds.FirstOrDefault(g => g.Id == guildId);
    public List<Guild> GetAllGuilds() => new(state.Guilds);
    public Guild GetGuildByPlayerId(int playerId) => state.Guilds.FirstOrDefault(g => g.OwnerId == playerId);
    public District GetDistrict(int districtId) => state.Districts.FirstOrDefault(d => d.Id == districtId);
    public List<District> GetAllDistricts() => new(state.Districts);
    public List<District> GetDistrictsControlledBy(int guildId) => state.Districts.Where(d => d.ControllingGuildId == guildId).ToList();
    public Faction GetFaction(int factionId) => state.Factions.FirstOrDefault(f => f.Id == factionId);
    public List<Faction> GetAllFactions() => new(state.Factions);

    public int GetFactionStanding(int guildId, int factionId)
    {
        var guild = GetGuild(guildId);
        return guild != null ? guild.GetFactionStanding(factionId) : 50;
    }

    public GamePhase GetCurrentPhase()
    {
        if (System.Enum.TryParse<GamePhase>(state.CurrentPhase, out var phase))
            return phase;
        return GamePhase.Upkeep;
    }
    public int GetCurrentRound() => state.CurrentRound;

    public void SetPhase(string phaseName)
    {
        state.CurrentPhase = phaseName;
        EventSystem.Instance?.Fire<string>(GameEvents.PHASE_CHANGED, phaseName);
    }

    public void AdvanceRound()
    {
        state.CurrentRound++;
        state.TurnCount = 0;
        EventSystem.Instance?.Fire(GameEvents.ROUND_ADVANCED);
    }

    public void UpdateGuildResources(int guildId, int amount)
    {
        var guild = GetGuild(guildId);
        if (guild != null)
        {
            guild.ReceiveMoney(amount);
            EventSystem.Instance?.Fire<int>(GameEvents.GUILD_UPDATED, guildId);
        }
    }

    public void UpdateGuildLeader(int guildId, int newLeaderId)
    {
        var guild = GetGuild(guildId);
        if (guild != null)
        {
            // Note: newLeaderId refers to character ID, not guild ID
            var newLeader = guild.Members.FirstOrDefault(m => m.Id == newLeaderId);
            if (newLeader != null && newLeader is GuildLeader leader)
            {
                guild.Leader = leader;
                EventSystem.Instance?.Fire<int, int>(GameEvents.GUILD_LEADER_CHANGED, guildId, newLeaderId);
            }
        }
    }

    public bool CanGuildAfford(int guildId, int cost)
    {
        var guild = GetGuild(guildId);
        return guild != null && guild.Gold >= cost;
    }

    public void SetDistrictController(int districtId, int newControllerGuildId)
    {
        var district = GetDistrict(districtId);
        if (district == null) return;
        district.ControllingGuildId = newControllerGuildId;
        EventSystem.Instance?.Fire<int, int>(GameEvents.DISTRICT_CONTROL_CHANGED, districtId, newControllerGuildId);
    }

    public void TransferDistrictResources(int fromDistrictId, int toGuildId)
    {
        var district = GetDistrict(fromDistrictId);
        if (district != null)
        {
            // Sum all produced resources as gold
            int totalResources = district.ProducedResources.Values.Sum();
            UpdateGuildResources(toGuildId, totalResources);
        }
    }

    public void UpdateFactionStanding(int guildId, int factionId, int delta)
    {
        var guild = GetGuild(guildId);
        if (guild == null) return;
        int currentStanding = guild.GetFactionStanding(factionId);
        int newStanding = Mathf.Clamp(currentStanding + delta, 0, 100);
        guild.UpdateFactionStanding(factionId, newStanding);
        EventSystem.Instance?.Fire<int, int, int>(GameEvents.FACTION_STANDING_CHANGED, factionId, guildId, newStanding);
    }

    // ==================== STATE MUTATION ====================

    public void AddGuild(Guild guild)
    {
        state.Guilds.Add(guild);
        EventSystem.Instance?.Fire<int>(GameEvents.GUILD_CREATED, guild.Id);
    }

    public void AddDistrict(District district)
    {
        state.Districts.Add(district);
        EventSystem.Instance?.Fire<int>(GameEvents.DISTRICT_CREATED, district.Id);
    }

    public void AddFaction(Faction faction)
    {
        state.Factions.Add(faction);
    }

    public void TryTransferDistrict(int districtId, int newControllerGuildId)
    {
        SetDistrictController(districtId, newControllerGuildId);
    }

    // ==================== THREATS ====================

    public void AddThreat(Threat threat)
    {
        state.Threats.Add(threat);
        EventSystem.Instance?.Fire(GameEvents.THREAT_PLACED);
    }

    public List<Threat> GetAllThreats() => new(state.Threats);

    public Threat GetThreat(int threatId) => state.Threats.FirstOrDefault(t => t.Id == threatId);

    // ==================== TRADING DESTINATIONS ====================

    public void AddTradingDestination(TradingDestination dest)
    {
        state.TradingDestinations.Add(dest);
    }

    public List<TradingDestination> GetAllTradingDestinations() => new(state.TradingDestinations);

    // ==================== CITY LEADERSHIP ====================

    public void SetCityLeadership(string leaderName, string successionMethod)
    {
        state.CityLeaderName = leaderName;
        state.CitySuccessionMethod = successionMethod;
    }

    public string GetCityLeaderName() => state.CityLeaderName;
    public string GetCitySuccessionMethod() => state.CitySuccessionMethod;

    public void SetCurrentPhase(GamePhase phase)
    {
        state.CurrentPhase = phase.ToString();
        EventSystem.Instance?.Fire<GamePhase>(GameEvents.PHASE_CHANGED, phase);
    }

    public bool IsGameComplete()
    {
        // Check if any guild has a faction at victory threshold (90)
        return state.Guilds.Any(g => g.GetAllFactionStandings().Values.Any(standing => standing >= 90));
    }

    public GameState GetStateSnapshot() => state;
}

// Guild, GuildCharacter, and District are now defined in their respective files: Guild.cs, District.cs
// Remove duplicates to avoid CS0101 errors

public enum GamePhase
{
    SessionZero,
    Upkeep,
    Planning,
    Execution,
    Bills
}

/// <summary>
/// Pre-defined event name constants to avoid typos and improve discoverability.
/// </summary>
public static class GameEvents
{
    // Game state
    public const string GAME_STARTED = "game:started";
    public const string GAME_ENDED = "game:ended";
    public const string GAME_PAUSED = "game:paused";
    public const string GAME_RESUMED = "game:resumed";

    // Phase events
    public const string PHASE_CHANGED = "phase:changed";
    public const string SESSION_ZERO_START = "phase:sessionzero:start";
    public const string SESSION_ZERO_END = "phase:sessionzero:end";
    public const string UPKEEP_PHASE_START = "phase:upkeep:start";
    public const string UPKEEP_PHASE_END = "phase:upkeep:end";
    public const string PLANNING_PHASE_START = "phase:planning:start";
    public const string PLANNING_PHASE_END = "phase:planning:end";
    public const string EXECUTION_PHASE_START = "phase:execution:start";
    public const string EXECUTION_PHASE_END = "phase:execution:end";
    public const string BILLS_PHASE_START = "phase:bills:start";
    public const string BILLS_PHASE_END = "phase:bills:end";

    // Round events
    public const string ROUND_ADVANCED = "round:advanced";

    // Guild events
    public const string GUILD_CREATED = "guild:created";
    public const string GUILD_DESTROYED = "guild:destroyed";
    public const string GUILD_UPDATED = "guild:updated";
    public const string GUILD_LEADER_CHANGED = "guild:leader:changed";
    public const string GUILD_MEMBER_ADDED = "guild:member:added";
    public const string GUILD_MEMBER_REMOVED = "guild:member:removed";

    // District events
    public const string DISTRICT_CREATED = "district:created";
    public const string DISTRICT_CONTROL_CHANGED = "district:control:changed";
    public const string DISTRICT_THREATENED = "district:threatened";
    public const string DISTRICT_THREAT_RESOLVED = "district:threat:resolved";

    // Faction events
    public const string FACTION_STANDING_CHANGED = "faction:standing:changed";
    public const string FACTION_MISSION_COMPLETED = "faction:mission:completed";

    // Action events
    public const string ACTION_QUEUED = "action:queued";
    public const string ACTION_EXECUTED = "action:executed";
    public const string ACTION_FAILED = "action:failed";

    // Combat events
    public const string COMBAT_STARTED = "combat:started";
    public const string COMBAT_ENDED = "combat:ended";
    public const string CHARACTER_DAMAGED = "character:damaged";
    public const string CHARACTER_INCAPACITATED = "character:incapacitated";

    // Veto events
    public const string VETO_CALLED = "veto:called";
    public const string VETO_RESOLVED = "veto:resolved";

    // Session Zero events
    public const string TERRAIN_PLACED = "sessionzero:terrain:placed";
    public const string THREAT_PLACED = "sessionzero:threat:placed";
    public const string TRADING_DEST_ADDED = "sessionzero:trade:added";
    public const string SESSION_ZERO_STEP_CHANGED = "sessionzero:step:changed";

    // UI events
    public const string UI_SHOW_ACTION_PANEL = "ui:show:action_panel";
    public const string UI_HIDE_ACTION_PANEL = "ui:hide:action_panel";
    public const string UI_SELECT_DISTRICT = "ui:select:district";
}

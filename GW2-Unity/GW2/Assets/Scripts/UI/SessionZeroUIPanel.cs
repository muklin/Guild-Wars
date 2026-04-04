using UnityEngine;
using UnityEngine.UI;
using System.Collections.Generic;
using System.Linq;

/// <summary>
/// UI Panel for Session Zero: step-by-step city and guild creation.
///
/// Steps shown:
///   1. Terrain Setup      — place landscape features on the grid
///   2. District Setup     — place districts, threats, trading destinations
///   3. HQ Placement       — choose a headquarters district
///   4. Guild Setup        — name guild, create leader and second
///
/// All [SerializeField] references must be wired in the Unity Inspector.
/// Each step panel (terrainPanel, districtSetupPanel, hqPanel, guildSetupPanel)
/// is a child GameObject that is shown/hidden as the step advances.
/// </summary>
public class SessionZeroUIPanel : UIPanel
{
    // ─── Shared ───────────────────────────────────────────────────────
    [Header("Shared")]
    [SerializeField] private Text stepTitleText;
    [SerializeField] private Text logText;
    [SerializeField] private Text statusText;

    // ─── Step 1: Terrain ──────────────────────────────────────────────
    [Header("Step 1 – Terrain")]
    [SerializeField] private GameObject terrainPanel;
    [SerializeField] private Dropdown terrainTypeDropdown;
    [SerializeField] private Dropdown terrainGridCellDropdown;
    [SerializeField] private InputField terrainDescriptionInput;
    [SerializeField] private Button placeTerrainButton;
    [SerializeField] private Button doneTerrainButton;

    // ─── Step 2: District Setup ───────────────────────────────────────
    [Header("Step 2 – District Setup")]
    [SerializeField] private GameObject districtSetupPanel;
    [SerializeField] private Text turnIndicatorText;
    // Action type dropdown: 0=District, 1=Threat, 2=Trade, 3=Leadership
    [SerializeField] private Dropdown actionTypeDropdown;
    [SerializeField] private Button confirmActionButton;
    [SerializeField] private Button passButton;

    [Header("District Form")]
    [SerializeField] private GameObject districtForm;
    [SerializeField] private InputField districtNameInput;
    [SerializeField] private Dropdown districtClassDropdown;
    [SerializeField] private InputField districtFactionInput;
    [SerializeField] private InputField districtProducesInput;
    [SerializeField] private InputField districtConsumes1Input;
    [SerializeField] private InputField districtConsumes2Input;
    [SerializeField] private InputField districtConsumes3Input;
    [SerializeField] private InputField districtConsumes4Input;
    [SerializeField] private Dropdown districtGridCellDropdown;
    [SerializeField] private Toggle districtWalledToggle;

    [Header("Threat Form")]
    [SerializeField] private GameObject threatForm;
    [SerializeField] private InputField threatNameInput;
    [SerializeField] private InputField threatDescriptionInput;
    [SerializeField] private InputField threatDCInput;
    [SerializeField] private InputField threatMitigationInput;
    [SerializeField] private Dropdown threatGridCellDropdown;

    [Header("Trade Form")]
    [SerializeField] private GameObject tradeForm;
    [SerializeField] private InputField tradeNameInput;
    [SerializeField] private InputField tradeProducesInput;  // comma-separated
    [SerializeField] private InputField tradeConsumesInput;  // comma-separated

    [Header("Leadership Form")]
    [SerializeField] private GameObject leadershipForm;
    [SerializeField] private InputField leadershipHeadInput;
    [SerializeField] private InputField leadershipSuccessionInput;

    // ─── Step 3: HQ Placement ─────────────────────────────────────────
    [Header("Step 3 – HQ Placement")]
    [SerializeField] private GameObject hqPanel;
    [SerializeField] private Dropdown hqDistrictDropdown;
    [SerializeField] private Button placeHQButton;

    // ─── Step 4: Guild Setup ──────────────────────────────────────────
    [Header("Step 4 – Guild Setup")]
    [SerializeField] private GameObject guildSetupPanel;
    [SerializeField] private InputField guildNameInput;
    [SerializeField] private InputField leaderNameInput;
    [SerializeField] private Dropdown leaderClassDropdown;
    [SerializeField] private InputField secondNameInput;
    [SerializeField] private Dropdown secondClassDropdown;
    [SerializeField] private Button startGameButton;

    // ─── State ────────────────────────────────────────────────────────
    private SessionZeroPhase sessionZero;
    private List<District> hqDistrictOptions = new();

    // ─── Lifecycle ────────────────────────────────────────────────────

    protected void Awake()
    {
        sessionZero = SessionZeroManager.Instance?.Phase;
        if (sessionZero == null)
            Debug.LogWarning("[SessionZeroUIPanel] SessionZeroPhase not found — ensure SessionZeroManager exists.");
    }

    protected void OnEnable()
    {
        BindButtons(true);
        InitDropdowns();
        Refresh();
    }

    protected void OnDisable()
    {
        BindButtons(false);
    }

    private void BindButtons(bool add)
    {
        Bind(placeTerrainButton,  OnPlaceTerrainClicked,  add);
        Bind(doneTerrainButton,   OnDoneTerrainClicked,   add);
        Bind(confirmActionButton, OnConfirmActionClicked, add);
        Bind(passButton,          OnPassClicked,          add);
        Bind(placeHQButton,       OnPlaceHQClicked,       add);
        Bind(startGameButton,     OnStartGameClicked,     add);

        if (actionTypeDropdown != null)
        {
            if (add) actionTypeDropdown.onValueChanged.AddListener(OnActionTypeChanged);
            else     actionTypeDropdown.onValueChanged.RemoveListener(OnActionTypeChanged);
        }
    }

    private static void Bind(Button btn, UnityEngine.Events.UnityAction action, bool add)
    {
        if (btn == null) return;
        if (add) btn.onClick.AddListener(action);
        else     btn.onClick.RemoveListener(action);
    }

    // ─── Dropdown Initialization ──────────────────────────────────────

    private void InitDropdowns()
    {
        SetOptions(terrainTypeDropdown,    new[] { "Desert", "Mountains", "Forest", "River", "Delta", "Plains", "Cliffs", "Sea", "Other" });
        SetOptions(districtClassDropdown,  new[] { "Neutral", "Commerce", "Military", "Magical", "Religious", "Noble" });
        SetOptions(actionTypeDropdown,     new[] { "Place District", "Place Threat", "Add Trading Destination", "Define City Leadership" });

        var classes = new[] { "Barbarian", "Bard", "Cleric", "Druid", "Fighter", "Monk", "Paladin", "Ranger", "Rogue", "Sorcerer", "Warlock", "Wizard" };
        SetOptions(leaderClassDropdown,  classes);
        SetOptions(secondClassDropdown,  classes);

        // Grid cell options: (x, z) for a 5×5 grid
        var cells = Enumerable.Range(0, 25).Select(i => $"({i % 5}, {i / 5})").ToArray();
        SetOptions(terrainGridCellDropdown,  cells);
        SetOptions(districtGridCellDropdown, cells);
        SetOptions(threatGridCellDropdown,   cells);
    }

    private static void SetOptions(Dropdown dropdown, IEnumerable<string> options)
    {
        if (dropdown == null) return;
        dropdown.ClearOptions();
        dropdown.AddOptions(options.ToList());
    }

    // ─── Refresh (main display update) ───────────────────────────────

    public override void Refresh()
    {
        if (sessionZero == null) return;

        UpdateStepTitle();
        UpdateLog();
        ShowStepPanel();
    }

    private void UpdateStepTitle()
    {
        if (stepTitleText == null) return;
        stepTitleText.text = sessionZero.CurrentStep switch
        {
            SessionZeroStep.Terrain       => "Step 1: Terrain Setup",
            SessionZeroStep.DistrictSetup => "Step 2: District Setup",
            SessionZeroStep.HQPlacement   => "Step 3: Place Headquarters",
            SessionZeroStep.GuildSetup    => "Step 4: Guild Setup",
            SessionZeroStep.Complete      => "Session Zero Complete",
            _                             => "Session Zero"
        };
    }

    private void UpdateLog()
    {
        if (logText == null) return;
        var log = sessionZero.SetupLog;
        int start = Mathf.Max(0, log.Count - 20);
        logText.text = string.Join("\n", log.GetRange(start, log.Count - start));
    }

    private void ShowStepPanel()
    {
        SetActive(terrainPanel,       sessionZero.CurrentStep == SessionZeroStep.Terrain);
        SetActive(districtSetupPanel, sessionZero.CurrentStep == SessionZeroStep.DistrictSetup);
        SetActive(hqPanel,            sessionZero.CurrentStep == SessionZeroStep.HQPlacement);
        SetActive(guildSetupPanel,    sessionZero.CurrentStep == SessionZeroStep.GuildSetup);

        if (sessionZero.CurrentStep == SessionZeroStep.DistrictSetup)
            UpdateDistrictTurnUI();

        if (sessionZero.CurrentStep == SessionZeroStep.HQPlacement)
            RefreshHQDropdown();
    }

    private void UpdateDistrictTurnUI()
    {
        bool isPlayerTurn = sessionZero.IsPlayerTurn();

        if (turnIndicatorText != null)
            turnIndicatorText.text = isPlayerTurn ? "Your Turn" : "Waiting for NPCs...";

        SetInteractable(confirmActionButton, isPlayerTurn);
        SetInteractable(passButton, isPlayerTurn);

        // Show the correct sub-form
        int action = actionTypeDropdown?.value ?? 0;
        SetActive(districtForm,   action == 0);
        SetActive(threatForm,     action == 1);
        SetActive(tradeForm,      action == 2);
        SetActive(leadershipForm, action == 3);
    }

    private void RefreshHQDropdown()
    {
        if (hqDistrictDropdown == null) return;
        hqDistrictOptions = GameStateManager.Instance?.GetAllDistricts() ?? new List<District>();
        hqDistrictDropdown.ClearOptions();
        hqDistrictDropdown.AddOptions(hqDistrictOptions.Select(d => d.Name).ToList());
    }

    // ─── Step 1: Terrain Handlers ─────────────────────────────────────

    private void OnPlaceTerrainClicked()
    {
        if (sessionZero == null) return;
        string desc = terrainDescriptionInput?.text?.Trim() ?? "";
        if (string.IsNullOrEmpty(desc)) { ShowStatus("Enter a terrain description.", Color.red); return; }

        int typeIdx = terrainTypeDropdown?.value ?? 0;
        int cellIdx = terrainGridCellDropdown?.value ?? 0;
        bool ok = sessionZero.PlaceTerrainFeature((TerrainType)typeIdx, desc, cellIdx % 5, cellIdx / 5);
        if (ok)
        {
            ShowStatus($"{(TerrainType)typeIdx} placed.", Color.green);
            if (terrainDescriptionInput) terrainDescriptionInput.text = "";
            Refresh();
        }
    }

    private void OnDoneTerrainClicked()
    {
        if (sessionZero == null) return;
        bool ok = sessionZero.FinishTerrainPlacement();
        if (!ok) ShowStatus("Place at least one terrain feature first.", Color.red);
        else Refresh();
    }

    // ─── Step 2: District Setup Handlers ─────────────────────────────

    private void OnActionTypeChanged(int _) => UpdateDistrictTurnUI();

    private void OnConfirmActionClicked()
    {
        if (sessionZero == null) return;
        int action = actionTypeDropdown?.value ?? 0;

        bool success = action switch
        {
            0 => ConfirmPlaceDistrict(),
            1 => ConfirmPlaceThreat(),
            2 => ConfirmAddTrade(),
            3 => ConfirmDefineLeadership(),
            _ => false
        };

        if (success)
        {
            ClearDistrictForms();
            Refresh();
        }
    }

    private bool ConfirmPlaceDistrict()
    {
        string name    = districtNameInput?.text?.Trim() ?? "";
        string faction = districtFactionInput?.text?.Trim() ?? "";
        string produces = districtProducesInput?.text?.Trim() ?? "";
        var consumes = new List<string>
        {
            districtConsumes1Input?.text?.Trim() ?? "",
            districtConsumes2Input?.text?.Trim() ?? "",
            districtConsumes3Input?.text?.Trim() ?? "",
            districtConsumes4Input?.text?.Trim() ?? "",
        };
        int cellIdx = districtGridCellDropdown?.value ?? 0;
        bool walled = districtWalledToggle?.isOn ?? false;
        var cls = (DistrictClass)(districtClassDropdown?.value ?? 0);

        if (string.IsNullOrEmpty(name))    { ShowStatus("Enter a district name.", Color.red);      return false; }
        if (string.IsNullOrEmpty(produces)) { ShowStatus("Enter a produced resource.", Color.red); return false; }
        if (consumes.Count(c => !string.IsNullOrEmpty(c)) < 3)
            { ShowStatus("Enter at least 3 consumed resources.", Color.red); return false; }

        bool ok = sessionZero.PlaceDistrict(name, cls, faction, produces, consumes, cellIdx % 5, cellIdx / 5, walled);
        if (!ok) ShowStatus("Could not place district.", Color.red);
        else     ShowStatus($"District '{name}' placed.", Color.green);
        return ok;
    }

    private bool ConfirmPlaceThreat()
    {
        string name    = threatNameInput?.text?.Trim() ?? "";
        string desc    = threatDescriptionInput?.text?.Trim() ?? "";
        string mitigation = threatMitigationInput?.text?.Trim() ?? "";
        int dc         = int.TryParse(threatDCInput?.text, out int parsed) ? parsed : 12;
        int cellIdx    = threatGridCellDropdown?.value ?? 0;

        if (string.IsNullOrEmpty(name)) { ShowStatus("Enter a threat name.", Color.red); return false; }

        bool ok = sessionZero.PlaceThreat(name, desc, dc, mitigation, cellIdx % 5, cellIdx / 5);
        if (!ok) ShowStatus("Could not place threat.", Color.red);
        else     ShowStatus($"Threat '{name}' placed.", Color.green);
        return ok;
    }

    private bool ConfirmAddTrade()
    {
        string name = tradeNameInput?.text?.Trim() ?? "";
        var produces = Split(tradeProducesInput?.text ?? "");
        var consumes = Split(tradeConsumesInput?.text ?? "");

        if (string.IsNullOrEmpty(name)) { ShowStatus("Enter a trading destination name.", Color.red); return false; }

        bool ok = sessionZero.AddTradingDestination(name, produces, consumes);
        if (!ok) ShowStatus("Could not add trading destination.", Color.red);
        else     ShowStatus($"Trading destination '{name}' added.", Color.green);
        return ok;
    }

    private bool ConfirmDefineLeadership()
    {
        string head      = leadershipHeadInput?.text?.Trim() ?? "";
        string succession = leadershipSuccessionInput?.text?.Trim() ?? "";

        if (string.IsNullOrEmpty(head)) { ShowStatus("Enter the head of state.", Color.red); return false; }

        sessionZero.DefineCityLeadership(head, succession);
        ShowStatus($"City leadership set: {head}.", Color.green);
        Refresh();
        return false; // Leadership is informational; doesn't consume the turn
    }

    private void OnPassClicked()
    {
        sessionZero?.PassDistrictSetup();
        Refresh();
    }

    private void ClearDistrictForms()
    {
        foreach (var field in new[] {
            districtNameInput, districtFactionInput, districtProducesInput,
            districtConsumes1Input, districtConsumes2Input, districtConsumes3Input, districtConsumes4Input,
            threatNameInput, threatDescriptionInput, threatDCInput, threatMitigationInput,
            tradeNameInput, tradeProducesInput, tradeConsumesInput,
            leadershipHeadInput, leadershipSuccessionInput })
        {
            if (field != null) field.text = "";
        }
    }

    // ─── Step 3: HQ Placement Handlers ───────────────────────────────

    private void OnPlaceHQClicked()
    {
        if (sessionZero == null || hqDistrictOptions.Count == 0) return;
        int idx = hqDistrictDropdown?.value ?? 0;
        if (idx >= hqDistrictOptions.Count) return;

        bool ok = sessionZero.PlacePlayerHQ(hqDistrictOptions[idx].Id);
        if (ok)
        {
            ShowStatus("Headquarters placed!", Color.green);
            Refresh();
        }
        else
            ShowStatus("Could not place HQ.", Color.red);
    }

    // ─── Step 4: Guild Setup Handlers ────────────────────────────────

    private void OnStartGameClicked()
    {
        if (sessionZero == null) return;

        string guildName   = guildNameInput?.text?.Trim() ?? "";
        string leaderName  = leaderNameInput?.text?.Trim() ?? "";
        string leaderClass = leaderClassDropdown != null
            ? leaderClassDropdown.options[leaderClassDropdown.value].text
            : "Fighter";
        string secondName  = secondNameInput?.text?.Trim() ?? "";
        string secondClass = secondClassDropdown != null
            ? secondClassDropdown.options[secondClassDropdown.value].text
            : "Fighter";

        bool ok = sessionZero.CreatePlayerGuild(guildName, leaderName, leaderClass, secondName, secondClass);
        if (ok)
        {
            ShowStatus("Game starting...", Color.cyan);
            Refresh();
        }
        else
            ShowStatus("Enter a guild name and leader name.", Color.red);
    }

    // ─── Helpers ─────────────────────────────────────────────────────

    private static void SetActive(GameObject obj, bool active)
    {
        if (obj != null) obj.SetActive(active);
    }

    private static void SetInteractable(Button btn, bool interactable)
    {
        if (btn != null) btn.interactable = interactable;
    }

    private static List<string> Split(string input) =>
        input.Split(',').Select(s => s.Trim()).Where(s => !string.IsNullOrEmpty(s)).ToList();

    private void ShowStatus(string message, Color color)
    {
        if (statusText != null) { statusText.text = message; statusText.color = color; }
        Debug.Log($"[SessionZeroUI] {message}");
    }

    public override void ShowPanel()
    {
        base.ShowPanel();
        sessionZero = SessionZeroManager.Instance?.Phase;
        Refresh();
    }
}

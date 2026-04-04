using UnityEngine;

/// <summary>
/// ActionSubmissionPanel: Shown during Planning phase.
/// Player selects: Action type, target, squad member.
/// Submits action or auto-advances if timeout.
/// </summary>
public class ActionSubmissionPanel : UIPanel
{
    private Dropdown actionTypeDropdown;
    private Dropdown targetDropdown;
    private Dropdown squadMemberDropdown;
    private Button submitButton;
    private Text statusText;
    private PlanningPhase planningPhase;
    private GameStateManager gameStateManager;
    private Guild playerGuild;

    public override void Initialize()
    {
        base.Initialize();
        try
        {
            gameStateManager = GameStateManager.Instance;

            if (gameStateManager == null)
            {
                Debug.LogError("[ActionSubmissionPanel] GameStateManager not found!");
                return;
            }

            // Guilds don't exist yet during UI initialization (they're created in Session Zero).
            // We'll initialize playerGuild in ShowPanel() when Planning phase starts.

            // Position: center-bottom
            rectTransform.anchorMin = new Vector2(0.33f, 0);
            rectTransform.anchorMax = new Vector2(0.66f, 0.25f);
            rectTransform.offsetMin = Vector2.zero;
            rectTransform.offsetMax = Vector2.zero;

            // Background
            GetComponent<Image>().color = new Color(0.15f, 0.15f, 0.2f, 0.95f);

            // Title
            CreateTextObject("Title", "Submit Action", transform, 32).GetComponent<Text>().color = Color.white;

            // Action type dropdown
            CreateTextObject("ActionLabel", "Action Type:", transform, 20).GetComponent<Text>().color = Color.white;
            var actionTypeObj = new GameObject("ActionTypeDropdown");
            actionTypeObj.transform.SetParent(transform, false);
            actionTypeDropdown = actionTypeObj.AddComponent<Dropdown>();
            actionTypeDropdown.options.Add(new Dropdown.OptionData("Select..."));
            actionTypeDropdown.options.Add(new Dropdown.OptionData("PvP (1v1 Duel)"));
            actionTypeDropdown.options.Add(new Dropdown.OptionData("District Control"));
            actionTypeDropdown.options.Add(new Dropdown.OptionData("Steal Resources"));
            actionTypeDropdown.onValueChanged.AddListener(OnActionTypeChanged);

            // Target dropdown
            CreateTextObject("TargetLabel", "Target:", transform, 20).GetComponent<Text>().color = Color.white;
            var targetObj = new GameObject("TargetDropdown");
            targetObj.transform.SetParent(transform, false);
            targetDropdown = targetObj.AddComponent<Dropdown>();
            targetDropdown.options.Add(new Dropdown.OptionData("Select target..."));

            // Squad member dropdown
            CreateTextObject("SquadLabel", "Squad Member:", transform, 20).GetComponent<Text>().color = Color.white;
            var squadObj = new GameObject("SquadMemberDropdown");
            squadObj.transform.SetParent(transform, false);
            squadMemberDropdown = squadObj.AddComponent<Dropdown>();

            // Status text
            statusText = CreateTextObject("Status", "Ready to submit", transform, 18).GetComponent<Text>();
            statusText.color = Color.yellow;

            // Submit button
            submitButton = CreateButtonWithText("SubmitButton", "Submit Action", transform, OnSubmitAction)
                .GetComponent<Button>();

            RefreshLayout();
            Debug.Log("[ActionSubmissionPanel] Successfully initialized! (Guilds will be loaded when panel is shown)");
        }
        catch (System.Exception e)
        {
            Debug.LogError($"[ActionSubmissionPanel] Initialize failed: {e.Message}\n{e.StackTrace}");
        }
    }

    private void OnActionTypeChanged(int index)
    {
        // Repopulate target dropdown based on action type
        targetDropdown.options.Clear();
        targetDropdown.options.Add(new Dropdown.OptionData("Select target..."));

        if (index == 1) // PvP
        {
            var otherGuilds = gameStateManager.GetAllGuilds();
            foreach (var guild in otherGuilds)
            {
                if (guild.Id != playerGuild.Id)
                {
                    targetDropdown.options.Add(new Dropdown.OptionData(guild.Name));
                }
            }
        }
        else if (index == 2) // District Control
        {
            var districts = gameStateManager.GetAllDistricts();
            foreach (var district in districts)
            {
                targetDropdown.options.Add(new Dropdown.OptionData(district.Name));
            }
        }
        else if (index == 3) // Steal Resources
        {
            var districts = gameStateManager.GetAllDistricts();
            foreach (var district in districts)
            {
                targetDropdown.options.Add(new Dropdown.OptionData(district.Name));
            }
        }
    }

    private void PopulateSquadMembers()
    {
        squadMemberDropdown.options.Clear();
        squadMemberDropdown.options.Add(new Dropdown.OptionData("Select member..."));

        if (playerGuild != null)
        {
            foreach (var member in playerGuild.Members)
            {
                squadMemberDropdown.options.Add(new Dropdown.OptionData(member.Name));
            }
        }
    }

    private void OnSubmitAction()
    {
        if (actionTypeDropdown.value == 0)
        {
            statusText.text = "Please select an action type";
            statusText.color = Color.red;
            return;
        }

        if (targetDropdown.value == 0)
        {
            statusText.text = "Please select a target";
            statusText.color = Color.red;
            return;
        }

        if (squadMemberDropdown.value == 0)
        {
            statusText.text = "Please select a squad member";
            statusText.color = Color.red;
            return;
        }

        // Create and submit action
        ActionBase action = null;
        int actionType = actionTypeDropdown.value;
        int targetIndex = targetDropdown.value - 1;
        int memberIndex = squadMemberDropdown.value - 1;

        var memberList = playerGuild.Members;
        if (memberIndex < 0 || memberIndex >= memberList.Count)
        {
            statusText.text = "Invalid member selection";
            statusText.color = Color.red;
            return;
        }

        var member = memberList[memberIndex];

        if (actionType == 1) // PvP
        {
            var otherGuilds = gameStateManager.GetAllGuilds();
            var guildFiltered = new System.Collections.Generic.List<Guild>();
            foreach (var g in otherGuilds)
            {
                if (g.Id != playerGuild.Id)
                    guildFiltered.Add(g);
            }

            if (targetIndex >= guildFiltered.Count)
            {
                statusText.text = "Invalid target";
                statusText.color = Color.red;
                return;
            }

            var targetGuild = guildFiltered[targetIndex];
            var targetMember = targetGuild.Members[0]; // Just pick first member for simplicity

            action = new PvPAction(playerGuild.Id)
            {
                AttackerCharacterId = member.Id,
                DefenderCharacterId = targetMember.Id,
                DefenderGuildId = targetGuild.Id
            };
        }
        else if (actionType == 2) // District Control
        {
            var districts = gameStateManager.GetAllDistricts();
            if (targetIndex >= districts.Count)
            {
                statusText.text = "Invalid district";
                statusText.color = Color.red;
                return;
            }

            action = new DistrictControlAction(playerGuild.Id, districts[targetIndex].Id);
        }
        else if (actionType == 3) // Steal Resources
        {
            var districts = gameStateManager.GetAllDistricts();
            if (targetIndex >= districts.Count)
            {
                statusText.text = "Invalid target district";
                statusText.color = Color.red;
                return;
            }

            action = new StealResourcesAction(playerGuild.Id, districts[targetIndex].Id, member.Id);
        }

        if (action != null)
        {
            // Get PlanningPhase and submit
            planningPhase = (PlanningPhase)GamePhaseManager.Instance.GetPhaseHandler(GamePhase.Planning);
            if (planningPhase != null)
            {
                planningPhase.SubmitAction(playerGuild.Id, action);
                statusText.text = "Action submitted!";
                statusText.color = Color.green;

                // Reset dropdowns
                actionTypeDropdown.value = 0;
                targetDropdown.value = 0;
                squadMemberDropdown.value = 0;
            }
        }
    }

    public override void ShowPanel()
    {
        base.ShowPanel();

        // Initialize guild data on first show (when guilds now exist)
        if (playerGuild == null)
        {
            var allGuilds = gameStateManager?.GetAllGuilds();
            if (allGuilds != null && allGuilds.Count > 0)
            {
                playerGuild = allGuilds[0]; // Player is always first guild
                Debug.Log($"[ActionSubmissionPanel] Using player guild: {playerGuild.Name}");
                PopulateSquadMembers();
            }
        }

        // Reset UI when panel shows
        actionTypeDropdown.value = 0;
        targetDropdown.value = 0;
        squadMemberDropdown.value = 0;
        statusText.text = "Ready to submit";
        statusText.color = Color.yellow;
    }
}

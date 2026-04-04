/// <summary>
/// Resource Theft Action: Steal resources from a district.
/// If district is controlled by another guild, triggers 1v1 PvP.
/// </summary>
public class ResourceTheftAction : ActionBase
{
    public new int TargetDistrictId { get; set; }
    public string ResourceType { get; set; }
    public int Amount { get; set; }

    public ResourceTheftAction(int guildId, int districtId, string resourceType, int amount) : base(guildId)
    {
        Type = ActionType.ResourceTheft;
        TargetDistrictId = districtId;
        ResourceType = resourceType;
        Amount = amount;
    }

    public override bool IsValid(GameStateManager gameState)
    {
        var district = gameState.GetDistrict(TargetDistrictId);
        return district != null && district.ProducedResources.ContainsKey(ResourceType);
    }

    public override ActionResult Execute(GameStateManager gameState)
    {
        var result = new ActionResult(true, $"Stole {Amount} {ResourceType}");
        // TODO: Implement theft with optional PvP if district is controlled
        return result;
    }
}

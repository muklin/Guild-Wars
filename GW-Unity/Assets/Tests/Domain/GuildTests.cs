using NUnit.Framework;

/// <summary>
/// Unit tests for Guild class (which inherits from Faction).
/// </summary>
public class GuildTests
{
    [Test]
    public void Guild_Creation_WithExplicitID_SetsProperties()
    {
        var guild = new Guild(1, "Player Guild", 1);

        Assert.AreEqual(1, guild.Id);
        Assert.AreEqual("Player Guild", guild.Name);
        Assert.AreEqual(1, guild.OwnerId);
        Assert.AreEqual(200, guild.Gold);
    }

    [Test]
    public void Guild_Inherits_From_Faction()
    {
        var guild = new Guild(1, "Test Guild", 1);
        Assert.IsInstanceOf<Faction>(guild);
    }

    [Test]
    public void Guild_CanAddMember()
    {
        var guild = new Guild(1, "Test Guild", 1);
        var character = new GuildCharacter("Hero", "Fighter", 1);

        guild.AddMember(character);

        Assert.AreEqual(1, guild.Members.Count);
        Assert.IsTrue(guild.Members.Contains(character));
    }

    [Test]
    public void Guild_DoesNotDuplicate_Members()
    {
        var guild = new Guild(1, "Test Guild", 1);
        var character = new GuildCharacter("Hero", "Fighter", 1);

        guild.AddMember(character);
        guild.AddMember(character);

        Assert.AreEqual(1, guild.Members.Count);
    }

    [Test]
    public void Guild_CanRemoveMember()
    {
        var guild = new Guild(1, "Test Guild", 1);
        var character = new GuildCharacter("Hero", "Fighter", 1);

        guild.AddMember(character);
        guild.RemoveMember(character);

        Assert.AreEqual(0, guild.Members.Count);
    }

    [Test]
    public void Guild_CanAddResource()
    {
        var guild = new Guild(1, "Test Guild", 1);
        guild.AddResource("Gold", 100);

        Assert.AreEqual(100, guild.GetResourceAmount("Gold"));
    }

    [Test]
    public void Guild_CanConsumeResource()
    {
        var guild = new Guild(1, "Test Guild", 1);
        guild.AddResource("Food", 50);

        bool success = guild.TryConsumeResource("Food", 30);

        Assert.IsTrue(success);
        Assert.AreEqual(20, guild.GetResourceAmount("Food"));
    }

    [Test]
    public void Guild_TryConsumeResource_ReturnsFalseWhenInsufficientAmount()
    {
        var guild = new Guild(1, "Test Guild", 1);
        guild.AddResource("Food", 20);

        bool success = guild.TryConsumeResource("Food", 30);

        Assert.IsFalse(success);
        Assert.AreEqual(20, guild.GetResourceAmount("Food")); // Unchanged
    }

    [Test]
    public void Guild_GetResourceAmount_Returns_Zero_For_Unknown_Resource()
    {
        var guild = new Guild(1, "Test Guild", 1);
        Assert.AreEqual(0, guild.GetResourceAmount("Unknown"));
    }

    [Test]
    public void Guild_CanUpdateFactionStanding()
    {
        var guild = new Guild(1, "Test Guild", 1);
        guild.UpdateFactionStanding(100, 75);

        Assert.AreEqual(75, guild.GetFactionStanding(100));
    }

    [Test]
    public void Guild_GetFactionStanding_Returns_50_Default()
    {
        var guild = new Guild(1, "Test Guild", 1);
        Assert.AreEqual(50, guild.GetFactionStanding(999));
    }

    [Test]
    public void Guild_CanAddControlledDistrict()
    {
        var guild = new Guild(1, "Test Guild", 1);
        guild.AddControlledDistrict(1);

        Assert.IsTrue(guild.ControlsDistrict(1));
        Assert.AreEqual(1, guild.ControlledDistrictIds.Count);
    }

    [Test]
    public void Guild_CanRemoveControlledDistrict()
    {
        var guild = new Guild(1, "Test Guild", 1);
        guild.AddControlledDistrict(1);
        guild.RemoveControlledDistrict(1);

        Assert.IsFalse(guild.ControlsDistrict(1));
        Assert.AreEqual(0, guild.ControlledDistrictIds.Count);
    }

    [Test]
    public void Guild_CanPayMoney()
    {
        var guild = new Guild(1, "Test Guild", 1);
        guild.Gold = 100;

        bool success = guild.TryPayMoney(50);

        Assert.IsTrue(success);
        Assert.AreEqual(50, guild.Gold);
    }

    [Test]
    public void Guild_TryPayMoney_ReturnsFalseWhenInsufficientGold()
    {
        var guild = new Guild(1, "Test Guild", 1);
        guild.Gold = 30;

        bool success = guild.TryPayMoney(50);

        Assert.IsFalse(success);
        Assert.AreEqual(30, guild.Gold); // Unchanged
    }

    [Test]
    public void Guild_CanReceiveMoney()
    {
        var guild = new Guild(1, "Test Guild", 1);
        guild.Gold = 100;
        guild.ReceiveMoney(50);

        Assert.AreEqual(150, guild.Gold);
    }

    [Test]
    public void Guild_Session_Zero_Tokens_AreInitialized()
    {
        var guild = new Guild(1, "Test Guild", 1);

        Assert.AreEqual(1, guild.VetoTokens);
        Assert.AreEqual(2, guild.GuildTokens);
        Assert.AreEqual(2, guild.CharacterTokens);
        Assert.AreEqual(2, guild.RoundTokens);
    }
}

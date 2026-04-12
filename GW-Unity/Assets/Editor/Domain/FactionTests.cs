using NUnit.Framework;
using UnityEngine;
using System.Linq;

/// <summary>
/// Unit tests for Faction base class and its methods.
/// </summary>
public class FactionTests
{
    [Test]
    public void Faction_Creation_WithAutoID_SetsName()
    {
        var faction = new Faction("Merchants Guild");

        Assert.IsNotNull(faction);
        Assert.AreEqual("Merchants Guild", faction.Name);
        Assert.GreaterOrEqual(faction.Id, 100); // Auto-IDs start at 100
    }

    [Test]
    public void Faction_Creation_WithExplicitID_SetsID()
    {
        var faction = new Guild(1, "Player Guild", 1);

        Assert.AreEqual(1, faction.Id);
        Assert.AreEqual("Player Guild", faction.Name);
    }

    [Test]
    public void Faction_AddProducedResource_CreatesResource()
    {
        var faction = new Faction("Test Faction");
        faction.AddProducedResource("Gold");

        Assert.AreEqual(1, faction.Produces.Count);
        Assert.AreEqual("Gold", faction.Produces[0].Name);
        Assert.IsInstanceOf<Resource>(faction.Produces[0]);
    }

    [Test]
    public void Faction_AddProducedService_CreatesService()
    {
        var faction = new Faction("Test Faction");
        faction.AddProducedService("Protection");

        Assert.AreEqual(1, faction.Produces.Count);
        Assert.AreEqual("Protection", faction.Produces[0].Name);
        Assert.IsInstanceOf<Service>(faction.Produces[0]);
    }

    [Test]
    public void Faction_AddNeededResource_CreatesResource()
    {
        var faction = new Faction("Test Faction");
        faction.AddNeededResource("Wood");

        Assert.AreEqual(1, faction.Needs.Count);
        Assert.AreEqual("Wood", faction.Needs[0].Name);
        Assert.IsInstanceOf<Resource>(faction.Needs[0]);
    }

    [Test]
    public void Faction_ProducesItem_ChecksCorrectly()
    {
        var faction = new Faction("Test Faction");
        faction.AddProducedResource("Gold");

        Assert.IsTrue(faction.ProducesItem("Gold"));
        Assert.IsFalse(faction.ProducesItem("Wood"));
    }

    [Test]
    public void Faction_NeedsItem_ChecksCorrectly()
    {
        var faction = new Faction("Test Faction");
        faction.AddNeededResource("Food");

        Assert.IsTrue(faction.NeedsItem("Food"));
        Assert.IsFalse(faction.NeedsItem("Gold"));
    }

    [Test]
    public void Faction_DoesNotDuplicate_ProducedItems()
    {
        var faction = new Faction("Test Faction");
        faction.AddProducedResource("Gold");
        faction.AddProducedResource("Gold");

        Assert.AreEqual(1, faction.Produces.Count);
    }

    [Test]
    public void Faction_VictoryThreshold_Defaults_To_90()
    {
        var faction = new Faction("Test Faction");
        Assert.AreEqual(90, faction.VictoryThreshold);
    }

    [Test]
    public void Faction_HQStandingBonus_Defaults_To_20()
    {
        var faction = new Faction("Test Faction");
        Assert.AreEqual(20, faction.HQStandingBonus);
    }

    [Test]
    public void Faction_ToString_IsCorrect()
    {
        var faction = new Faction("Test Faction");
        Assert.That(faction.ToString(), Contains.Substring("Faction"));
        Assert.That(faction.ToString(), Contains.Substring("Test Faction"));
    }
}

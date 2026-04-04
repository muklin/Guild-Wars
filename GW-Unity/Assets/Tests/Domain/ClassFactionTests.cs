using NUnit.Framework;
using UnityEngine;

/// <summary>
/// Unit tests for ClassFaction class (which inherits from Faction).
/// </summary>
public class ClassFactionTests
{
    [Test]
    public void ClassFaction_Creation_SetsNameAndTier()
    {
        var classFaction = new ClassFaction("Upper Class", "Upper");

        Assert.AreEqual("Upper Class", classFaction.Name);
        Assert.AreEqual("Upper", classFaction.SocialTier);
    }

    [Test]
    public void ClassFaction_Inherits_From_Faction()
    {
        var classFaction = new ClassFaction("Test Class", "Test");
        Assert.IsInstanceOf<Faction>(classFaction);
    }

    [Test]
    public void ClassFaction_CanAddExampleGroup()
    {
        var classFaction = new ClassFaction("Upper Class", "Upper");
        classFaction.AddExampleGroup("Nobility");

        Assert.AreEqual(1, classFaction.ExampleGroups.Count);
        Assert.Contains("Nobility", classFaction.ExampleGroups);
    }

    [Test]
    public void ClassFaction_DoesNotDuplicate_ExampleGroups()
    {
        var classFaction = new ClassFaction("Upper Class", "Upper");
        classFaction.AddExampleGroup("Nobility");
        classFaction.AddExampleGroup("Nobility");

        Assert.AreEqual(1, classFaction.ExampleGroups.Count);
    }

    [Test]
    public void ClassFaction_CanAddMultipleExampleGroups()
    {
        var classFaction = new ClassFaction("Upper Class", "Upper");
        classFaction.AddExampleGroup("Nobility");
        classFaction.AddExampleGroup("Clergy");
        classFaction.AddExampleGroup("Merchants");

        Assert.AreEqual(3, classFaction.ExampleGroups.Count);
    }

    [Test]
    public void ClassFaction_ToString_IsCorrect()
    {
        var classFaction = new ClassFaction("Upper Class", "Upper");
        var str = classFaction.ToString();

        Assert.That(str, Contains.Substring("ClassFaction"));
        Assert.That(str, Contains.Substring("Upper Class"));
        Assert.That(str, Contains.Substring("Upper"));
    }

    [Test]
    public void ClassFaction_Can_Produce_And_Need_Items()
    {
        var classFaction = new ClassFaction("Merchant Class", "Middle");
        classFaction.AddProducedResource("Goods");
        classFaction.AddNeededResource("Gold");

        Assert.AreEqual(1, classFaction.Produces.Count);
        Assert.AreEqual(1, classFaction.Needs.Count);
    }
}

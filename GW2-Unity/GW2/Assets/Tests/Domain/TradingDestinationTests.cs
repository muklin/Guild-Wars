using NUnit.Framework;

/// <summary>
/// Unit tests for TradingDestination class (which inherits from Faction).
/// </summary>
public class TradingDestinationTests
{
    [Test]
    public void TradingDestination_Creation_SetsNameAndDescription()
    {
        var destination = new TradingDestination("Harbor Port", "Coastal trade hub");

        Assert.AreEqual("Harbor Port", destination.Name);
        Assert.AreEqual("Coastal trade hub", destination.Description);
    }

    [Test]
    public void TradingDestination_Inherits_From_Faction()
    {
        var destination = new TradingDestination("Test Port");
        Assert.IsInstanceOf<Faction>(destination);
    }

    [Test]
    public void TradingDestination_CanAddProducedResource()
    {
        var destination = new TradingDestination("Test Port");
        destination.AddProducedResource("Spices");

        Assert.AreEqual(1, destination.Produces.Count);
        Assert.AreEqual("Spices", destination.Produces[0].Name);
    }

    [Test]
    public void TradingDestination_CanAddConsumedResource()
    {
        var destination = new TradingDestination("Test Port");
        destination.AddConsumedResource("Gold");

        Assert.AreEqual(1, destination.Needs.Count);
        Assert.AreEqual("Gold", destination.Needs[0].Name);
    }

    [Test]
    public void TradingDestination_ProducedResourceNames_ReturnsCorrectList()
    {
        var destination = new TradingDestination("Test Port");
        destination.AddProducedResource("Spices");
        destination.AddProducedResource("Silk");

        var names = destination.ProducedResourceNames;

        Assert.AreEqual(2, names.Count);
        Assert.Contains("Spices", names);
        Assert.Contains("Silk", names);
    }

    [Test]
    public void TradingDestination_ConsumedResourceNames_ReturnsCorrectList()
    {
        var destination = new TradingDestination("Test Port");
        destination.AddConsumedResource("Gold");
        destination.AddConsumedResource("Wood");

        var names = destination.ConsumedResourceNames;

        Assert.AreEqual(2, names.Count);
        Assert.Contains("Gold", names);
        Assert.Contains("Wood", names);
    }

    [Test]
    public void TradingDestination_ToString_IsCorrect()
    {
        var destination = new TradingDestination("Test Port");
        destination.AddProducedResource("Spices");
        destination.AddConsumedResource("Gold");

        var str = destination.ToString();

        Assert.That(str, Contains.Substring("TradingDest"));
        Assert.That(str, Contains.Substring("Test Port"));
        Assert.That(str, Contains.Substring("Spices"));
        Assert.That(str, Contains.Substring("Gold"));
    }
}

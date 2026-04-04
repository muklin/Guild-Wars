using NUnit.Framework;
using UnityEngine;


/// <summary>
/// Unit tests for District class (which inherits from Faction).
/// </summary>
public class DistrictTests
{
    [Test]
    public void District_Creation_SetsNameAndPosition()
    {
        var position = new Vector3(5, 0, 10);
        var district = new District("Market Square", position);

        Assert.AreEqual("Market Square", district.Name);
        Assert.AreEqual(position, district.WorldPosition);
    }

    [Test]
    public void District_Inherits_From_Faction()
    {
        var district = new District("Test District", Vector3.zero);
        Assert.IsInstanceOf<Faction>(district);
    }

    [Test]
    public void District_CanAddProducedResource()
    {
        var district = new District("Test District", Vector3.zero);
        district.AddProducedResource("Gold", 30);

        Assert.IsTrue(district.ProducedResources.ContainsKey("Gold"));
        Assert.AreEqual(30, district.ProducedResources["Gold"]);
    }

    [Test]
    public void District_ProducedResource_SyncsToFactionProduces()
    {
        var district = new District("Test District", Vector3.zero);
        district.AddProducedResource("Gold", 30);

        Assert.AreEqual(1, district.Produces.Count);
        Assert.AreEqual("Gold", district.Produces[0].Name);
    }

    [Test]
    public void District_CanAddConsumedResource()
    {
        var district = new District("Test District", Vector3.zero);
        district.AddConsumedResource("Food", 10);

        Assert.IsTrue(district.ConsumedResources.ContainsKey("Food"));
        Assert.AreEqual(10, district.ConsumedResources["Food"]);
    }

    [Test]
    public void District_ConsumedResource_SyncsToFactionNeeds()
    {
        var district = new District("Test District", Vector3.zero);
        district.AddConsumedResource("Food", 10);

        Assert.AreEqual(1, district.Needs.Count);
        Assert.AreEqual("Food", district.Needs[0].Name);
    }

    [Test]
    public void District_ControllingGuildId_Defaults_To_Minus_One()
    {
        var district = new District("Test District", Vector3.zero);
        Assert.AreEqual(-1, district.ControllingGuildId);
    }

    [Test]
    public void District_IsControlled_ReturnsTrueWhenControllerSet()
    {
        var district = new District("Test District", Vector3.zero);
        district.ControllingGuildId = 1;

        Assert.IsTrue(district.IsControlled());
        Assert.IsTrue(district.IsControlledBy(1));
        Assert.IsFalse(district.IsControlledBy(2));
    }

    [Test]
    public void District_IsControlled_ReturnsFalseWhenUncontrolled()
    {
        var district = new District("Test District", Vector3.zero);
        Assert.IsFalse(district.IsControlled());
    }

    [Test]
    public void District_CanAddAdjacentDistrict()
    {
        var district1 = new District("District 1", Vector3.zero);
        var district2 = new District("District 2", Vector3.right * 10);

        district1.AddAdjacentDistrict(district2.Id);

        Assert.IsTrue(district1.IsAdjacent(district2.Id));
    }

    [Test]
    public void District_DoesNotDuplicate_AdjacentDistricts()
    {
        var district1 = new District("District 1", Vector3.zero);
        var district2 = new District("District 2", Vector3.right * 10);

        district1.AddAdjacentDistrict(district2.Id);
        district1.AddAdjacentDistrict(district2.Id);

        Assert.AreEqual(1, district1.AdjacentDistrictIds.Count);
    }

    [Test]
    public void District_GenerateResources_ReturnsCopy()
    {
        var district = new District("Test District", Vector3.zero);
        district.AddProducedResource("Gold", 30);

        var resources = district.GenerateResources();
        resources["Gold"] = 50; // Modify copy

        Assert.AreEqual(30, district.ProducedResources["Gold"]); // Original unchanged
    }

    [Test]
    public void District_IsThreatened_ReturnsFalseByDefault()
    {
        var district = new District("Test District", Vector3.zero);
        Assert.IsFalse(district.IsThreatened);
    }

    [Test]
    public void District_Class_CanBeSet()
    {
        var district = new District("Test District", Vector3.zero);
        district.Class = DistrictClass.Commerce;

        Assert.AreEqual(DistrictClass.Commerce, district.Class);
    }

    [Test]
    public void District_FactionLabel_CanBeSet()
    {
        var district = new District("Test District", Vector3.zero);
        district.FactionLabel = "Merchants Guild";

        Assert.AreEqual("Merchants Guild", district.FactionLabel);
    }
}

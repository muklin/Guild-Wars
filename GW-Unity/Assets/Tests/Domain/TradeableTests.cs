using NUnit.Framework;
using UnityEngine;

/// <summary>
/// Unit tests for Tradeable, Resource, and Service classes.
/// </summary>
public class TradeableTests
{
    [Test]
    public void Resource_Creation_SetsNameAndType()
    {
        var resource = new Resource("Gold", "Currency for trading");

        Assert.IsNotNull(resource);
        Assert.AreEqual("Gold", resource.Name);
        Assert.AreEqual("Currency for trading", resource.Description);
    }

    [Test]
    public void Service_Creation_SetsNameAndType()
    {
        var service = new Service("Protection", "Guard services");

        Assert.IsNotNull(service);
        Assert.AreEqual("Protection", service.Name);
        Assert.AreEqual("Guard services", service.Description);
    }

    [Test]
    public void Resource_And_Service_Have_Unique_IDs()
    {
        var resource1 = new Resource("Gold");
        var resource2 = new Resource("Wood");
        var service1 = new Service("Protection");
        var service2 = new Service("Transport");

        Assert.AreNotEqual(resource1.Id, resource2.Id);
        Assert.AreNotEqual(service1.Id, service2.Id);
        Assert.AreNotEqual(resource1.Id, service1.Id);
    }

    [Test]
    public void Resource_ToString_IsCorrect()
    {
        var resource = new Resource("Gold");
        Assert.AreEqual("Resource[Gold]", resource.ToString());
    }

    [Test]
    public void Service_ToString_IsCorrect()
    {
        var service = new Service("Protection");
        Assert.AreEqual("Service[Protection]", service.ToString());
    }
}

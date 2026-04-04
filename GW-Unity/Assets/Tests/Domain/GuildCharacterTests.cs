using NUnit.Framework;
using UnityEngine;

/// <summary>
/// Unit tests for GuildCharacter and GuildLeader classes.
/// </summary>
public class GuildCharacterTests
{
    [Test]
    public void GuildCharacter_Creation_SetsProperties()
    {
        var character = new GuildCharacter("Hero", "Fighter", 3);

        Assert.AreEqual("Hero", character.Name);
        Assert.AreEqual("Fighter", character.Class);
        Assert.AreEqual(3, character.Level);
    }

    [Test]
    public void GuildCharacter_MaxHitPoints_CalculatedFromLevel()
    {
        var character = new GuildCharacter("Hero", "Fighter", 1);
        Assert.AreEqual(10, character.MaxHitPoints); // 10 + (1-1) * 5

        character = new GuildCharacter("Veteran", "Fighter", 3);
        Assert.AreEqual(20, character.MaxHitPoints); // 10 + (3-1) * 5
    }

    [Test]
    public void GuildCharacter_HitPoints_StartFull()
    {
        var character = new GuildCharacter("Hero", "Fighter", 2);
        Assert.AreEqual(character.MaxHitPoints, character.HitPoints);
    }

    [Test]
    public void GuildCharacter_TakeDamage_ReducesHitPoints()
    {
        var character = new GuildCharacter("Hero", "Fighter", 3);
        character.TakeDamage(5);

        Assert.AreEqual(character.MaxHitPoints - 5, character.HitPoints);
    }

    [Test]
    public void GuildCharacter_TakeDamage_DoesNotGoBelowZero()
    {
        var character = new GuildCharacter("Hero", "Fighter", 1);
        character.TakeDamage(20); // More than max HP

        Assert.AreEqual(0, character.HitPoints);
    }

    [Test]
    public void GuildCharacter_TakeDamage_TriggerIncapacitation()
    {
        var character = new GuildCharacter("Hero", "Fighter", 1);
        character.TakeDamage(10); // Kill the character

        Assert.IsTrue(character.IsIncapacitated);
    }

    [Test]
    public void GuildCharacter_Heal_RestoresHitPoints()
    {
        var character = new GuildCharacter("Hero", "Fighter", 2);
        character.TakeDamage(5);
        character.Heal(3);

        Assert.AreEqual(character.MaxHitPoints - 2, character.HitPoints);
    }

    [Test]
    public void GuildCharacter_Heal_DoesNotExceedMaxHitPoints()
    {
        var character = new GuildCharacter("Hero", "Fighter", 2);
        character.Heal(10);

        Assert.AreEqual(character.MaxHitPoints, character.HitPoints);
    }

    [Test]
    public void GuildCharacter_Heal_ClearsIncapacitation()
    {
        var character = new GuildCharacter("Hero", "Fighter", 1);
        character.TakeDamage(10);
        Assert.IsTrue(character.IsIncapacitated);

        character.Heal(10);
        Assert.IsFalse(character.IsIncapacitated);
    }

    [Test]
    public void GuildCharacter_Have_Unique_IDs()
    {
        var char1 = new GuildCharacter("Hero1", "Fighter", 1);
        var char2 = new GuildCharacter("Hero2", "Rogue", 1);

        Assert.AreNotEqual(char1.Id, char2.Id);
    }

    [Test]
    public void GuildLeader_Extends_GuildCharacter()
    {
        var leader = new GuildLeader("Chief", "Fighter", 3);
        Assert.IsInstanceOf<GuildCharacter>(leader);
    }

    [Test]
    public void GuildLeader_Has_Title()
    {
        var leader = new GuildLeader("Chief", "Fighter", 3, "Guild Master");
        Assert.AreEqual("Guild Master", leader.Title);
    }

    [Test]
    public void GuildLeader_Default_Title_Is_Leader()
    {
        var leader = new GuildLeader("Chief", "Fighter", 3);
        Assert.AreEqual("Leader", leader.Title);
    }
}

using System;

namespace GuildWars.Veto
{
    public interface IVetoable
    {
        string GetStatementId();
        string GetStatementText();
        int GetAuthorPlayerId();
        string GetCategory();
    }

    public abstract class VetoableStatement : IVetoable
    {
        public string StatementId { get; private set; }
        public string StatementText { get; private set; }
        public int AuthorPlayerId { get; private set; }
        public string Category { get; private set; }
        public DateTime CreatedAt { get; private set; }

        protected VetoableStatement(string id, string text, int authorPlayerId, string category)
        {
            StatementId = id;
            StatementText = text;
            AuthorPlayerId = authorPlayerId;
            Category = category;
            CreatedAt = DateTime.UtcNow;
        }

        public string GetStatementId() => StatementId;
        public string GetStatementText() => StatementText;
        public int GetAuthorPlayerId() => AuthorPlayerId;
        public string GetCategory() => Category;

        public override string ToString() => StatementText;
    }

    public class ActionStatement : VetoableStatement
    {
        public int ActionType { get; private set; }
        public int TargetGuildId { get; private set; }

        public ActionStatement(string id, string text, int authorPlayerId, int actionType, int targetGuildId)
            : base(id, text, authorPlayerId, "action")
        {
            ActionType = actionType;
            TargetGuildId = targetGuildId;
        }
    }

    public class DistrictClaimStatement : VetoableStatement
    {
        public int DistrictId { get; private set; }
        public int ClaimingGuildId { get; private set; }

        public DistrictClaimStatement(string id, string text, int authorPlayerId, int districtId, int claimingGuildId)
            : base(id, text, authorPlayerId, "district_claim")
        {
            DistrictId = districtId;
            ClaimingGuildId = claimingGuildId;
        }
    }

    public class LeaderChangeStatement : VetoableStatement
    {
        public int GuildId { get; private set; }
        public int NewLeaderId { get; private set; }

        public LeaderChangeStatement(string id, string text, int authorPlayerId, int guildId, int newLeaderId)
            : base(id, text, authorPlayerId, "leader_change")
        {
            GuildId = guildId;
            NewLeaderId = newLeaderId;
        }
    }
}

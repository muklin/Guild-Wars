namespace GuildWars.Veto
{
    public class VetoToken
    {
        public int PlayerId { get; private set; }
        public bool IsHeld { get; private set; }
        public string VetoedStatementCategory { get; private set; }
        public string LastVetoedStatementId { get; private set; }

        public VetoToken(int playerId)
        {
            PlayerId = playerId;
            IsHeld = true;
            VetoedStatementCategory = "";
            LastVetoedStatementId = "";
        }

        public void Spend()
        {
            IsHeld = false;
        }

        public void Regain()
        {
            IsHeld = true;
            VetoedStatementCategory = "";
            LastVetoedStatementId = "";
        }

        public bool CanVeto() => IsHeld;

        public void MarkVetoedStatement(string statementId, string category)
        {
            LastVetoedStatementId = statementId;
            VetoedStatementCategory = category;
        }

        public override string ToString() => $"Player {PlayerId}: {(IsHeld ? "HAS" : "NO")} token";
    }
}

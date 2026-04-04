using System.Collections.Generic;
using System.Linq;

namespace GuildWars.Veto
{
    public enum BallotType { Open, Closed }

    public class VotingSystem
    {
        private Dictionary<int, bool> votes = new();
        private int totalVoters = 0;
        private BallotType ballotType = BallotType.Open;

        public void InitializeVote(int totalPlayers, BallotType type)
        {
            votes.Clear();
            totalVoters = totalPlayers;
            ballotType = type;
        }

        public void CastVote(int playerId, bool voteForVeto)
        {
            if (!votes.ContainsKey(playerId))
                votes[playerId] = voteForVeto;
        }

        public void WithdrawVote(int playerId)
        {
            if (votes.ContainsKey(playerId))
                votes.Remove(playerId);
        }

        public bool IsComplete()
        {
            int voted = votes.Count;
            return voted >= totalVoters / 2 + 1;
        }

        public (bool vetoSucceeded, int votesFor, int votesAgainst) GetResult()
        {
            int votesFor = votes.Values.Where(v => v).Count();
            int votesAgainst = votes.Count - votesFor;
            int majority = totalVoters / 2 + 1;

            bool succeeded = votesFor >= majority;
            return (succeeded, votesFor, votesAgainst);
        }

        public int GetVoteCount() => votes.Count;
        public int GetTotalVoters() => totalVoters;
        public BallotType GetBallotType() => ballotType;
    }
}

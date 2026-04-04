using UnityEngine;
using System.Collections.Generic;
using System.Linq;

namespace GuildWars.Veto
{
    public class VetoManager : MonoBehaviour
    {
        public static VetoManager Instance { get; private set; }

        private Dictionary<int, VetoToken> playerTokens = new();
        private VotingSystem currentVote;
        private VetoableStatement currentStatement;
        private EventSystem eventSystem;
        private int vetoedStatementCount = 0;
        private bool isVotingActive = false;

        private void Awake()
        {
            if (Instance != null && Instance != this)
            {
                Destroy(gameObject);
                return;
            }
            Instance = this;
            DontDestroyOnLoad(gameObject);
            eventSystem = EventSystem.Instance;
        }

        public void InitializeForPlayers(int playerCount)
        {
            playerTokens.Clear();
            for (int i = 0; i < playerCount; i++)
            {
                playerTokens[i] = new VetoToken(i);
            }
            Debug.Log($"[VetoManager] Initialized for {playerCount} players");
        }

        public void OnStatementMade(VetoableStatement statement)
        {
            if (isVotingActive)
            {
                Debug.LogWarning("[VetoManager] Cannot make statement while veto vote is active");
                return;
            }

            currentStatement = statement;

            bool anyPlayerCanVeto = playerTokens.Values.Any(t => t.CanVeto());
            if (!anyPlayerCanVeto)
            {
                Debug.Log($"[VetoManager] Statement made but no one can veto: {statement.GetStatementText()}");
                eventSystem.Fire<string>(GameEvents.ACTION_QUEUED, statement.GetStatementText());
                return;
            }

            Debug.Log($"[VetoManager] Statement made (can be vetoed): {statement.GetStatementText()}");
            eventSystem.Fire<string>(GameEvents.VETO_CALLED, statement.GetStatementText());
        }

        public void CallVeto(int vetoPLayerId, BallotType ballotType)
        {
            if (!playerTokens.ContainsKey(vetoPLayerId))
            {
                Debug.LogError($"[VetoManager] Invalid veto player ID: {vetoPLayerId}");
                return;
            }

            var token = playerTokens[vetoPLayerId];
            if (!token.CanVeto())
            {
                Debug.Log($"[VetoManager] Player {vetoPLayerId} cannot veto (no token)");
                return;
            }

            if (currentStatement == null)
            {
                Debug.LogError("[VetoManager] No statement to veto");
                return;
            }

            isVotingActive = true;
            currentVote = new VotingSystem();
            currentVote.InitializeVote(playerTokens.Count, ballotType);

            token.Spend();
            Debug.Log($"[VetoManager] Veto called by player {vetoPLayerId}. Vote started ({ballotType} ballot)");
            eventSystem.Fire<string>(GameEvents.VETO_CALLED, currentStatement.GetStatementText());
        }

        public void CastVote(int playerId, bool voteForVeto)
        {
            if (!isVotingActive || currentVote == null)
            {
                Debug.LogWarning("[VetoManager] No active vote");
                return;
            }

            currentVote.CastVote(playerId, voteForVeto);
            Debug.Log($"[VetoManager] Player {playerId} voted {(voteForVeto ? "FOR" : "AGAINST")} veto");

            if (currentVote.IsComplete())
            {
                ResolveVeto();
            }
        }

        private void ResolveVeto()
        {
            if (currentVote == null || currentStatement == null)
            {
                Debug.LogError("[VetoManager] Cannot resolve: missing vote or statement");
                return;
            }

            var (succeeded, votesFor, votesAgainst) = currentVote.GetResult();
            isVotingActive = false;

            Debug.Log($"[VetoManager] Veto resolved: {(succeeded ? "SUCCEEDED" : "FAILED")} ({votesFor} for, {votesAgainst} against)");
            eventSystem.Fire<bool>(GameEvents.VETO_RESOLVED, succeeded);

            if (succeeded)
            {
                vetoedStatementCount++;
                Debug.Log($"[VetoManager] Statement vetoed. Author must restate differently.");
            }
            else
            {
                Debug.Log($"[VetoManager] Veto failed. Statement is valid and will be executed.");
            }

            currentStatement = null;
            currentVote = null;
        }

        public void RegainTokens()
        {
            int tokensHeld = playerTokens.Values.Where(t => t.IsHeld).Count();

            if (tokensHeld == 1)
            {
                Debug.Log("[VetoManager] Only 1 player has token. Regaining all tokens.");
                foreach (var token in playerTokens.Values)
                {
                    token.Regain();
                }
            }
        }

        public void RegainTokensForNewRound()
        {
            foreach (var token in playerTokens.Values)
            {
                token.Regain();
            }
            Debug.Log("[VetoManager] All tokens regained for new round");
        }

        public bool PlayerHasToken(int playerId)
        {
            return playerTokens.ContainsKey(playerId) && playerTokens[playerId].CanVeto();
        }

        public int GetTokensHeldCount() => playerTokens.Values.Where(t => t.IsHeld).Count();
        public bool IsVotingActive() => isVotingActive;
        public VetoableStatement GetCurrentStatement() => currentStatement;
        public VotingSystem GetCurrentVote() => currentVote;
    }
}

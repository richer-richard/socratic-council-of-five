import { useCallback, useMemo } from "react";
import { ConversationExport } from "../ConversationExport";
import { ConversationSearch } from "../ConversationSearch";
import { ConflictGraph } from "../ConflictGraph";
import { ProviderIcon } from "../icons/ProviderIcons";
import { apiLogger } from "../../services/api";
import { useConfig } from "../../stores/config";
import { useCouncilSessionStore } from "../../stores/councilSession";
import { AGENT_IDS, AGENT_UI, getModelDisplayName } from "../../features/chat/agentUi";
import { calculateMessageCost } from "../../utils/cost";

export function SidePanel({
  topic,
  onJumpToMessage,
  onNewDiscussion,
}: {
  topic: string;
  onJumpToMessage: (messageId: string) => void;
  onNewDiscussion: () => void;
}) {
  const { config, getConfiguredProviders } = useConfig();
  const configuredProviders = getConfiguredProviders();

  const sidePanelView = useCouncilSessionStore((s) => s.sidePanelView);
  const setSidePanelView = useCouncilSessionStore((s) => s.setSidePanelView);
  const messages = useCouncilSessionStore((s) => s.messages);
  const typingAgents = useCouncilSessionStore((s) => s.typingAgents);
  const currentTurn = useCouncilSessionStore((s) => s.currentTurn);
  const isRunning = useCouncilSessionStore((s) => s.isRunning);
  const showBidding = useCouncilSessionStore((s) => s.showBidding);
  const currentBidding = useCouncilSessionStore((s) => s.currentBidding);
  const totalTokens = useCouncilSessionStore((s) => s.totalTokens);
  const errors = useCouncilSessionStore((s) => s.errors);
  const costState = useCouncilSessionStore((s) => s.costState);
  const allConflicts = useCouncilSessionStore((s) => s.allConflicts);

  const getAgentLabel = useCallback((agentId: string) => {
    const agent = (AGENT_UI as Record<string, { name: string }>)[agentId];
    return agent?.name ?? agentId;
  }, []);

  const exportMessages = useMemo(() => {
    return messages
      .filter((m) => !m.isStreaming && (m.content ?? "").trim().length > 0)
      .map((m) => {
        const ui = AGENT_UI[m.agentId] ?? AGENT_UI.system;
        const modelName = m.metadata?.model ? getModelDisplayName(m.metadata.model) : undefined;
        const model = modelName && modelName !== "Unknown Model" ? modelName : undefined;
        return {
          id: m.id,
          agentId: m.agentId,
          speaker: m.displayName ?? ui.name,
          model,
          timestamp: m.timestamp,
          content: m.content,
          tokens: m.tokens,
          costUSD: calculateMessageCost(m.metadata?.model, m.tokens),
        };
      });
  }, [messages]);

  if (sidePanelView === "logs") {
    return (
      <div className="scale-in">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-xs font-semibold text-ink-500 uppercase tracking-[0.24em]">API Logs</h3>
          <button onClick={() => setSidePanelView("default")} className="button-ghost text-xs">
            Close
          </button>
        </div>
        <div className="space-y-2 text-xs">
          {apiLogger
            .getLogs()
            .slice(-20)
            .reverse()
            .map((log, i) => (
              <div
                key={i}
                className={`log-card ${log.level === "error" ? "error" : log.level === "warn" ? "warn" : ""}`}
              >
                <div className="flex items-center gap-2 mb-1">
                  <span className="font-medium">[{log.provider}]</span>
                  <span className="text-ink-500">{new Date(log.timestamp).toLocaleTimeString()}</span>
                </div>
                <div>{log.message}</div>
              </div>
            ))}
          {apiLogger.getLogs().length === 0 && <div className="text-ink-500 text-center py-4">No logs yet</div>}
        </div>
      </div>
    );
  }

  if (sidePanelView === "search") {
    return (
      <ConversationSearch
        messages={messages
          .filter((m) => (m.content ?? "").trim().length > 0)
          .map((m) => ({
            id: m.id,
            agentId: m.displayName ?? String(m.agentId),
            content: m.content,
            timestamp: m.timestamp,
          }))}
        getAgentLabel={getAgentLabel}
        onJumpToMessage={onJumpToMessage}
        onClose={() => setSidePanelView("default")}
      />
    );
  }

  if (sidePanelView === "export") {
    return <ConversationExport topic={topic} messages={exportMessages} onClose={() => setSidePanelView("default")} />;
  }

  return (
    <>
      <h3 className="text-xs font-semibold text-ink-500 uppercase tracking-[0.24em] mb-4">Council Members</h3>

      {/* Agent list with provider icons */}
      <div className="space-y-2 mb-6">
        {AGENT_IDS.map((agentId) => {
          const agent = AGENT_UI[agentId];
          const isSpeaking = typingAgents.includes(agentId);
          const hasApiKey = configuredProviders.includes(agent.provider);
          const modelName = getModelDisplayName(config.models[agent.provider]);

          return (
            <div
              key={agentId}
              className={`agent-row ${isSpeaking ? "speaking" : ""} ${!hasApiKey ? "opacity-50" : ""}`}
            >
              <div className={`relative ${isSpeaking ? "speaking-pulse" : ""}`}>
                <ProviderIcon provider={agent.provider} size={32} />
              </div>
              <div className="flex-1 min-w-0">
                <div className={`text-sm font-medium truncate ${agent.color}`}>{agent.name}</div>
                <div className="text-xs text-ink-500 truncate">{hasApiKey ? modelName : "No API key"}</div>
              </div>
              {isSpeaking && <span className="badge badge-success text-xs">Speaking</span>}
            </div>
          );
        })}
      </div>

      <ConflictGraph
        conflicts={allConflicts}
        agents={AGENT_IDS.map((id) => ({
          id,
          name: AGENT_UI[id].name,
          color: AGENT_UI[id].color,
        }))}
      />

      {/* Bidding display */}
      {showBidding && currentBidding && (
        <div className="scale-in">
          <h3 className="text-xs font-semibold text-ink-500 uppercase tracking-[0.24em] mb-3">Bidding Round</h3>
          <div className="panel-card p-3 space-y-2">
            {(Object.entries(currentBidding.scores) as [typeof AGENT_IDS[number], number][])
              .filter(([_, score]) => score > 0)
              .sort((a, b) => b[1] - a[1])
              .map(([agentId, score]) => {
                const agent = AGENT_UI[agentId];
                const isWinner = agentId === currentBidding.winner;
                const maxScore = Math.max(...Object.values(currentBidding.scores));
                const barWidth = (score / maxScore) * 100;

                return (
                  <div key={agentId} className={`${isWinner ? "winner-highlight" : ""}`}>
                    <div className="flex items-center justify-between text-xs mb-1">
                      <span className={`flex items-center gap-1 ${agent.color}`}>
                        {agent.name}
                        {isWinner && " ★"}
                      </span>
                      <span className="tabular-nums text-ink-500">{Math.round(score)}</span>
                    </div>
                    <div className="h-1.5 bg-white/70 rounded-full overflow-hidden">
                      <div
                        className={`h-full bidding-bar rounded-full ${
                          isWinner ? "bg-gradient-to-r from-emerald-600 to-amber-400" : "bg-slate-400"
                        }`}
                        style={{ width: `${barWidth}%` }}
                      />
                    </div>
                  </div>
                );
              })}
          </div>
        </div>
      )}

      <div className="panel-card p-4 mb-6">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-xs font-semibold text-ink-500 uppercase tracking-[0.24em]">Cost Ledger</h3>
          <span className="badge text-xs">{totalTokens.input + totalTokens.output} tokens</span>
        </div>
        {costState ? (
          <div className="space-y-2 text-xs">
            {AGENT_IDS.map((agentId) => {
              const agent = AGENT_UI[agentId];
              const breakdown = costState.agentCosts[agentId];
              const costLabel = breakdown?.pricingAvailable ? `$${breakdown.estimatedUSD.toFixed(4)}` : "—";
              const inputTokens = breakdown?.inputTokens ?? 0;
              const outputTokens = breakdown?.outputTokens ?? 0;

              return (
                <div key={agentId} className="flex items-center justify-between">
                  <span className={`text-ink-700 ${agent.color}`}>{agent.name}</span>
                  <span className="text-ink-500">
                    {inputTokens}/{outputTokens} · {costLabel}
                  </span>
                </div>
              );
            })}
            <div className="pt-2 border-t border-line-soft flex items-center justify-between">
              <span className="text-ink-500">Estimated total</span>
              <span className="text-ink-900">
                {Object.values(costState.agentCosts).some((agent) => agent.pricingAvailable)
                  ? `$${costState.totalEstimatedUSD.toFixed(4)}`
                  : "Pricing not configured"}
              </span>
            </div>
          </div>
        ) : (
          <div className="text-sm text-ink-500">No usage recorded yet.</div>
        )}
      </div>

      {/* Discussion stats */}
      {!isRunning && currentTurn > 0 && (
        <div className="mt-6 scale-in">
          <h3 className="text-xs font-semibold text-ink-500 uppercase tracking-[0.24em] mb-3">Summary</h3>
          <div className="panel-card p-4 space-y-3">
            <div className="flex justify-between text-sm">
              <span className="text-ink-500">Total turns</span>
              <span className="text-ink-900">{currentTurn}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-ink-500">Messages</span>
              <span className="text-ink-900">{messages.length}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-ink-500">Total tokens</span>
              <span className="text-ink-900">{totalTokens.input + totalTokens.output}</span>
            </div>
            {errors.length > 0 && (
              <div className="flex justify-between text-sm">
                <span className="text-ink-500">Errors</span>
                <span className="text-ink-900">{errors.length}</span>
              </div>
            )}
            <div className="pt-2 border-t border-line-soft">
              <button onClick={onNewDiscussion} className="w-full button-primary text-sm">
                New Discussion
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}


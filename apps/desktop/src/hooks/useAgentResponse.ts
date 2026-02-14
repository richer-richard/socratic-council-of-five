import { useCallback, useRef } from "react";
import type { CouncilEvent } from "@socratic-council/core";
import type { AgentId as CouncilAgentId } from "@socratic-council/shared";
import type { Provider } from "../stores/config";
import { useCouncilSessionStore, type ChatMessage } from "../stores/councilSession";
import { AGENT_UI, isCouncilAgent } from "../features/chat/agentUi";
import { applyReactions, extractMessageActions } from "../features/chat/messageActions";

type ModeratorDisplayLookup = (
  messageId: string
) => { displayName?: string; displayProvider?: Provider } | null;

function upsertStreamingMessage(messageId: string, agentId: CouncilAgentId): void {
  const store = useCouncilSessionStore.getState();
  const existing = store.messages.find((m) => m.id === messageId);
  if (existing) return;

  const ui = AGENT_UI[agentId] ?? AGENT_UI.system;
  store.upsertMessage({
    id: messageId,
    agentId,
    content: "",
    timestamp: Date.now(),
    isStreaming: true,
    displayName: ui.name,
    displayProvider: ui.provider,
  });
}

export function useAgentResponse(options?: {
  getModeratorDisplay?: ModeratorDisplayLookup;
  showBiddingScores?: boolean;
}) {
  const getModeratorDisplay = options?.getModeratorDisplay;
  const showBiddingScores = options?.showBiddingScores ?? true;

  const activeAgentIdRef = useRef<CouncilAgentId | null>(null);
  const activeMessageIdRef = useRef<string | null>(null);

  const onEvent = useCallback(
    (event: CouncilEvent) => {
      const store = useCouncilSessionStore.getState();

      switch (event.type) {
        case "turn_started": {
          activeAgentIdRef.current = event.agentId;
          activeMessageIdRef.current = event.messageId;

          store.setCurrentTurn(event.turnNumber);
          store.setTypingAgents(
            store.typingAgents.includes(event.agentId)
              ? store.typingAgents
              : [...store.typingAgents, event.agentId]
          );

          upsertStreamingMessage(event.messageId, event.agentId);
          break;
        }

        case "message_replace": {
          if (!isCouncilAgent(event.agentId)) break;
          upsertStreamingMessage(event.messageId, event.agentId);
          store.updateMessage(event.messageId, (m) => ({ ...m, content: event.content, isStreaming: true }));
          break;
        }

        case "message_chunk": {
          if (!isCouncilAgent(event.agentId)) break;
          upsertStreamingMessage(event.messageId, event.agentId);
          store.updateMessage(event.messageId, (m) => ({
            ...m,
            content: `${m.content ?? ""}${event.content}`,
            isStreaming: true,
          }));
          break;
        }

        case "message_complete": {
          const base: ChatMessage = {
            ...event.message,
            isStreaming: false,
          };

          const ui = AGENT_UI[base.agentId] ?? AGENT_UI.system;
          if (!base.displayName) {
            base.displayName = ui?.name ?? base.displayName;
          }
          if (isCouncilAgent(base.agentId)) {
            base.displayProvider = ui?.provider ?? base.displayProvider;
          }

          const moderatorDisplay = getModeratorDisplay?.(base.id);
          if (moderatorDisplay) {
            base.displayName = moderatorDisplay.displayName ?? base.displayName;
            base.displayProvider = moderatorDisplay.displayProvider ?? base.displayProvider;
          }

          let nextMessages = store.messages.slice();
          const existingIndex = nextMessages.findIndex((m) => m.id === base.id);
          if (existingIndex === -1) nextMessages.push(base);
          else nextMessages[existingIndex] = base;

          if (typeof base.tokens?.input === "number" && typeof base.tokens?.output === "number") {
            store.addTokens(base.tokens);
          }

          // Extract quotes + reactions from council agents only.
          if (isCouncilAgent(base.agentId)) {
            const { cleaned, quoteTargets, reactions } = extractMessageActions(base.content ?? "");
            const cleanedMessage = { ...base, content: cleaned, quotedMessageIds: quoteTargets };

            nextMessages[existingIndex === -1 ? nextMessages.length - 1 : existingIndex] = cleanedMessage;
            nextMessages = applyReactions(nextMessages, reactions, base.agentId);
          }

          // Remove from typing list once we get a completed council-agent message.
          if (isCouncilAgent(base.agentId)) {
            store.setTypingAgents(store.typingAgents.filter((id) => id !== base.agentId));
          }

          store.setMessages(nextMessages);
          break;
        }

        case "bidding_complete": {
          store.setCurrentBidding(event.round);
          if (showBiddingScores) {
            store.setShowBidding(true);
            window.setTimeout(() => {
              const current = useCouncilSessionStore.getState();
              if (current.showBidding) current.setShowBidding(false);
            }, 1500);
          }
          break;
        }

        case "cost_updated": {
          store.setCostState(event.costTracker);
          break;
        }

        case "conflict_updated": {
          store.setAllConflicts(event.pairs);
          store.setConflictState(event.strongestPair ?? null);
          break;
        }

        case "conflict_detected": {
          store.setConflictState(event.conflict);
          break;
        }

        case "duologue_started": {
          store.setDuoLogue(event.duoLogue);
          break;
        }

        case "duologue_ended": {
          store.setDuoLogue(null);
          store.setConflictState(null);
          break;
        }

        case "council_started": {
          store.setIsRunning(true);
          store.setIsPaused(false);
          break;
        }

        case "council_paused": {
          store.setIsPaused(true);
          break;
        }

        case "council_completed": {
          store.setIsRunning(false);
          store.setIsPaused(false);
          break;
        }

        case "error": {
          store.pushError(event.error.message);
          break;
        }
      }
    },
    [getModeratorDisplay]
  );

  return {
    onEvent,
    getActiveAgentId: () => activeAgentIdRef.current,
    getActiveMessageId: () => activeMessageIdRef.current,
  };
}

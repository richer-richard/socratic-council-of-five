import { useCallback } from "react";
import type { CSSProperties } from "react";
import type { AgentId as CouncilAgentId } from "@socratic-council/shared";
import { ProviderIcon, SystemIcon, UserIcon } from "../icons/ProviderIcons";
import { ReactionIcon, REACTION_CATALOG, type ReactionId } from "../icons/ReactionIcons";
import { Markdown } from "../Markdown";
import { splitIntoInlineQuoteSegments } from "../../utils/inlineQuotes";
import { calculateMessageCost } from "../../utils/cost";
import { AGENT_UI, formatTime, getModelDisplayName, isCouncilAgent, isModeratorMessage } from "../../features/chat/agentUi";
import { useCouncilSessionStore, type ChatMessage } from "../../stores/councilSession";

export function MessageBubble({
  message,
  typingAgents,
  messageById,
}: {
  message: ChatMessage;
  typingAgents: CouncilAgentId[];
  messageById: Map<string, ChatMessage>;
}) {
  const reactionPickerTarget = useCouncilSessionStore((s) => s.reactionPickerTarget);
  const setReactionPickerTarget = useCouncilSessionStore((s) => s.setReactionPickerTarget);
  const recentlyCopiedQuote = useCouncilSessionStore((s) => s.recentlyCopiedQuote);
  const setRecentlyCopiedQuote = useCouncilSessionStore((s) => s.setRecentlyCopiedQuote);
  const highlightedMessageId = useCouncilSessionStore((s) => s.highlightedMessageId);
  const toggleUserReaction = useCouncilSessionStore((s) => s.toggleUserReaction);

  const agent = AGENT_UI[message.agentId] ?? AGENT_UI.system;
  const isAgent = isCouncilAgent(message.agentId);
  const isSystem = message.agentId === "system";
  const isTool = message.agentId === "tool";
  const isModerator = isModeratorMessage(message);

  const displayName =
    typeof message.displayName === "string" && message.displayName.trim() ? message.displayName : agent.name;
  const nameClass = isModerator ? "text-emerald-300" : agent.color;
  const modelName = message.metadata?.model ? getModelDisplayName(message.metadata.model) : "";

  const accent = isModerator
    ? "var(--accent-emerald)"
    : isSystem || isTool
      ? "var(--accent-ink)"
      : message.agentId === "user"
        ? "var(--accent-emerald)"
        : `var(--color-${message.agentId})`;
  const accentStyle = { "--accent": accent } as CSSProperties;

  const reactionEntries = message.reactions
    ? (Object.entries(message.reactions) as [ReactionId, { count: number; by: string[] }][]).filter(
        ([, reaction]) => reaction?.count
      )
    : [];

  const isSuccess = isAgent && !message.isStreaming && !message.error && message.content;
  const messageStatusClass = message.error
    ? "has-error"
    : isSuccess
      ? "message-success"
      : message.isStreaming
        ? "is-streaming"
        : "";

  const isHighlighted = highlightedMessageId === message.id;

  const copyQuoteToken = useCallback(async () => {
    const token = `@quote(${message.id})`;
    try {
      await navigator.clipboard.writeText(token);
      setRecentlyCopiedQuote(message.id);
      window.setTimeout(() => setRecentlyCopiedQuote(null), 900);
    } catch {
      // Ignore clipboard failures (e.g., permission denied)
    }
  }, [message.id, setRecentlyCopiedQuote]);

  return (
    <div
      id={message.id}
      className={`discord-message message-enter ${messageStatusClass} ${isHighlighted ? "message-highlight" : ""}`}
      style={accentStyle}
    >
      {/* Avatar */}
      <div className="discord-avatar">
        {isSystem || isTool ? (
          message.displayProvider ? (
            <ProviderIcon provider={message.displayProvider} size={40} />
          ) : (
            <SystemIcon size={40} />
          )
        ) : message.agentId === "user" ? (
          <UserIcon size={40} />
        ) : (
          <ProviderIcon provider={agent.provider} size={40} />
        )}
        {isCouncilAgent(message.agentId) &&
          typingAgents.includes(message.agentId) &&
          message.isStreaming && <div className="avatar-speaking-indicator" />}
      </div>

      {/* Message content */}
      <div className="discord-message-content">
        {/* Header: Name (Model) + timestamp */}
        <div className="discord-message-header">
          <span className={`discord-username ${nameClass}`}>{displayName}</span>
          {(isAgent || isModerator) && modelName && <span className="discord-model">({modelName})</span>}
          <span className="discord-timestamp">{formatTime(message.timestamp)}</span>
          {message.tokens && (
            <span className="discord-tokens">
              {message.tokens.input}+{message.tokens.output} tokens
            </span>
          )}
          {(() => {
            const msgCost = calculateMessageCost(message.metadata?.model, message.tokens);
            return msgCost !== null ? (
              <span className="discord-cost">${msgCost.toFixed(4)}</span>
            ) : null;
          })()}
        </div>

        {/* Message body */}
        <div className="discord-message-body">
          {message.isStreaming ? (
            <div className="markdown-content" style={{ whiteSpace: "pre-wrap" }}>
              {message.content}
            </div>
          ) : (
            splitIntoInlineQuoteSegments(message.content).map((segment, idx) => {
              if (segment.type === "quote") {
                const qm = messageById.get(segment.id);
                if (!qm) {
                  return (
                    <div key={`${message.id}-quote-${idx}`} className="message-quote">
                      <div className="message-quote-header">Missing quote · @quote({segment.id})</div>
                      <div className="message-quote-body">Message not found.</div>
                    </div>
                  );
                }

                const qReactions = qm.reactions
                  ? (Object.entries(qm.reactions) as [ReactionId, { count: number; by: string[] }][]).filter(
                      ([, r]) => r?.count
                    )
                  : [];

                const quotedUi = AGENT_UI[qm.agentId] ?? AGENT_UI.system;
                const quotedName =
                  typeof qm.displayName === "string" && qm.displayName.trim()
                    ? qm.displayName
                    : quotedUi.name;

                return (
                  <div key={`${message.id}-quote-${idx}`} className="message-quote">
                    <div className="message-quote-header">
                      {quotedName} · {formatTime(qm.timestamp)}
                    </div>
                    <div className="message-quote-body">
                      {qm.content.slice(0, 200)}
                      {qm.content.length > 200 ? "…" : ""}
                    </div>
                    {qReactions.length > 0 && (
                      <div className="message-quote-reactions">
                        {qReactions.map(([reactionId, reaction]) => (
                          <div key={reactionId} className="reaction-chip">
                            <ReactionIcon type={reactionId} size={14} />
                            <span>{reaction.count}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              }

              if (!segment.text) return null;
              if (segment.text.trim() === "") {
                return (
                  <div
                    key={`${message.id}-text-${idx}`}
                    className="markdown-content"
                    style={{ whiteSpace: "pre-wrap" }}
                  >
                    {segment.text}
                  </div>
                );
              }

              return (
                <Markdown key={`${message.id}-text-${idx}`} content={segment.text} className="markdown-content" />
              );
            })
          )}
          {message.isStreaming && (
            <span className="typing-indicator">
              <span className="typing-dot" />
              <span className="typing-dot" />
              <span className="typing-dot" />
            </span>
          )}
        </div>

        <div className="message-actions">
          <button
            type="button"
            className="message-action"
            onClick={copyQuoteToken}
            title="Copy @quote() token to clipboard"
          >
            {recentlyCopiedQuote === message.id ? "Copied" : "Quote"}
          </button>
          <button
            type="button"
            className="message-action"
            onClick={() => setReactionPickerTarget(reactionPickerTarget === message.id ? null : message.id)}
            title="Add a reaction"
          >
            React
          </button>
        </div>

        {reactionPickerTarget === message.id && (
          <div className="reaction-picker" role="dialog" aria-label="Reaction picker">
            {REACTION_CATALOG.map((emoji) => (
              <button
                key={emoji}
                type="button"
                className="reaction-picker-item"
                onClick={() => {
                  toggleUserReaction(message.id, emoji);
                  setReactionPickerTarget(null);
                }}
                title={emoji}
                aria-label={`React ${emoji}`}
              >
                <ReactionIcon type={emoji} size={18} />
              </button>
            ))}
          </div>
        )}

        {reactionEntries.length > 0 && (
          <div className="reaction-bar">
            {reactionEntries.map(([reactionId, reaction]) => (
              <div key={reactionId} className="reaction-chip">
                <ReactionIcon type={reactionId} size={16} />
                <span>{reaction.count}</span>
              </div>
            ))}
          </div>
        )}

        {/* Error message */}
        {message.error && <div className="discord-error">{message.error}</div>}
      </div>
    </div>
  );
}

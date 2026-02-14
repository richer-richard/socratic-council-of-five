import { useEffect, useMemo, useRef, useState, forwardRef } from "react";
import type { HTMLAttributes } from "react";
import type { Page } from "../App";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import { useConfig } from "../stores/config";
import { useCouncilSession } from "../hooks/useCouncilSession";
import {
  getCouncilMessageById,
  getCouncilMessageIndexById,
  useCouncilSessionStore,
} from "../stores/councilSession";
import { MessageBubble } from "../components/chat/MessageBubble";
import { SidePanel } from "../components/chat/SidePanel";
import { AGENT_UI } from "../features/chat/agentUi";
import { ProviderIcon } from "../components/icons/ProviderIcons";

interface ChatProps {
  topic: string;
  onNavigate: (page: Page) => void;
}

const DiscordVirtuosoList = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  function DiscordVirtuosoList({ className, ...props }, ref) {
    return <div {...props} ref={ref} className={`discord-messages ${className ?? ""}`} />;
  }
);

export function Chat({ topic, onNavigate }: ChatProps) {
  const { config, getMaxTurns } = useConfig();
  const maxTurns = getMaxTurns();

  const { stop, pauseResume } = useCouncilSession(topic);

  const messages = useCouncilSessionStore((s) => s.messages);
  const typingAgents = useCouncilSessionStore((s) => s.typingAgents);
  const currentTurn = useCouncilSessionStore((s) => s.currentTurn);
  const isRunning = useCouncilSessionStore((s) => s.isRunning);
  const isPaused = useCouncilSessionStore((s) => s.isPaused);
  const totalTokens = useCouncilSessionStore((s) => s.totalTokens);
  const errors = useCouncilSessionStore((s) => s.errors);
  const sidePanelView = useCouncilSessionStore((s) => s.sidePanelView);
  const setSidePanelView = useCouncilSessionStore((s) => s.setSidePanelView);
  const costState = useCouncilSessionStore((s) => s.costState);
  const duoLogue = useCouncilSessionStore((s) => s.duoLogue);
  const highlightedMessageId = useCouncilSessionStore((s) => s.highlightedMessageId);
  const setHighlightedMessageId = useCouncilSessionStore((s) => s.setHighlightedMessageId);

  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const isAtBottomRef = useRef(true);
  const [showScrollButton, setShowScrollButton] = useState(false);

  const displayMaxTurns = maxTurns === Infinity ? "\u221E" : maxTurns;
  const virtuosoComponents = useMemo(() => ({ List: DiscordVirtuosoList }), []);

  const messageIndexById = useMemo(() => getCouncilMessageIndexById(messages), [messages]);
  const messageById = useMemo(() => getCouncilMessageById(messages), [messages]);

  useEffect(() => {
    if (!highlightedMessageId) return;
    const timer = window.setTimeout(() => setHighlightedMessageId(null), 1400);
    return () => window.clearTimeout(timer);
  }, [highlightedMessageId, setHighlightedMessageId]);

  const scrollToBottom = () => {
    virtuosoRef.current?.scrollToIndex({ index: "LAST", align: "end", behavior: "smooth" });
    isAtBottomRef.current = true;
    setShowScrollButton(false);
  };

  const jumpToMessage = (messageId: string) => {
    const index = messageIndexById.get(messageId);
    if (index === undefined) return;
    virtuosoRef.current?.scrollToIndex({ index, align: "center", behavior: "smooth" });
    setHighlightedMessageId(messageId);
  };

  const handleStopAndBack = () => {
    stop();
    onNavigate("home");
  };

  return (
    <div className="h-screen flex flex-col bg-gradient-to-br from-slate-50 to-slate-100">
      {/* Header */}
      <div className="app-header px-6 py-4 border-b border-line-soft bg-white/80 backdrop-blur-md relative z-20">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
          <div className="flex items-start gap-4">
            <button onClick={handleStopAndBack} className="button-ghost">
              &larr; Back
            </button>
            <div className="divider-vertical"></div>
            <div>
              <h1 className="text-lg font-semibold text-ink-900 flex items-center gap-2">
                Socratic Council
              </h1>
              <p className="text-sm text-ink-500 truncate max-w-lg">{topic}</p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3 justify-start lg:justify-end">
            <div className="flex items-center gap-2">
              <div className="text-sm text-ink-500">
                Turn {currentTurn}/{displayMaxTurns}
              </div>
              {maxTurns !== Infinity && (
                <div className="progress-track">
                  <div
                    className="progress-fill"
                    style={{ width: `${Math.min((currentTurn / maxTurns) * 100, 100)}%` }}
                  />
                </div>
              )}
            </div>

            <div className="badge badge-info">{totalTokens.input + totalTokens.output} tokens</div>

            {costState && (
              <div className="badge">
                {Object.values(costState.agentCosts).some((agent) => agent.pricingAvailable)
                  ? `$${costState.totalEstimatedUSD.toFixed(4)}`
                  : "Cost N/A"}
              </div>
            )}

            {duoLogue && (
              <div className="badge badge-warning">Conflict Focus · {duoLogue.remainingTurns} turns</div>
            )}

            <button
              onClick={() => setSidePanelView(sidePanelView === "logs" ? "default" : "logs")}
              className="button-secondary text-sm"
            >
              Logs {errors.length > 0 && `(${errors.length})`}
            </button>

            <button
              onClick={() => setSidePanelView(sidePanelView === "search" ? "default" : "search")}
              className="button-secondary text-sm"
            >
              Search
            </button>

            <button
              onClick={() => setSidePanelView(sidePanelView === "export" ? "default" : "export")}
              className="button-secondary text-sm"
            >
              Export
            </button>

            {isRunning && (
              <>
                <button
                  onClick={pauseResume}
                  className="button-secondary p-2"
                  title={isPaused ? "Resume" : "Pause"}
                >
                  {isPaused ? (
                    <svg
                      width="24"
                      height="24"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <circle cx="12" cy="12" r="10" />
                      <polygon points="10 8 16 12 10 16 10 8" fill="currentColor" stroke="none" />
                    </svg>
                  ) : (
                    <svg
                      width="24"
                      height="24"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <circle cx="12" cy="12" r="10" />
                      <line x1="10" y1="9" x2="10" y2="15" strokeWidth="2.5" />
                      <line x1="14" y1="9" x2="14" y2="15" strokeWidth="2.5" />
                    </svg>
                  )}
                </button>
                <button onClick={stop} className="button-primary p-2" title="Stop">
                  <svg
                    width="24"
                    height="24"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none" />
                  </svg>
                </button>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Main content */}
      <div className="flex-1 flex flex-col md:flex-row overflow-hidden relative z-10">
        {/* Messages */}
        <div className="flex-1 relative overflow-hidden">
          <Virtuoso
            ref={virtuosoRef}
            style={{ height: "100%" }}
            className="overflow-y-auto"
            data={messages}
            computeItemKey={(_, item) => item.id}
            followOutput={(isAtBottom) => (config.preferences.autoScroll && isAtBottom ? "smooth" : false)}
            atBottomStateChange={(atBottom) => {
              isAtBottomRef.current = atBottom;
              setShowScrollButton(!atBottom);
            }}
            components={virtuosoComponents}
            itemContent={(_, message) => (
              <MessageBubble message={message} typingAgents={typingAgents} messageById={messageById} />
            )}
          />

          {showScrollButton && (
            <button
              onClick={scrollToBottom}
              className="scroll-to-bottom-button"
              title="Scroll to bottom"
              aria-label="Scroll to bottom"
            >
              <svg
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <polyline points="6 9 12 15 18 9" />
              </svg>
            </button>
          )}
        </div>

        {/* Sidebar */}
        <div className="w-full md:w-80 md:border-l border-line-soft side-panel p-4 overflow-y-auto">
          <SidePanel
            topic={topic}
            onJumpToMessage={jumpToMessage}
            onNewDiscussion={handleStopAndBack}
          />
        </div>
      </div>

      {/* Footer - Current speaker indicator */}
      {typingAgents.length > 0 && (
        <div className="app-footer px-6 py-3">
          <div className="flex items-center justify-center gap-3 text-sm">
            {typingAgents.slice(0, 3).map((agentId) => (
              <span key={agentId} className="flex items-center gap-2">
                <ProviderIcon provider={AGENT_UI[agentId].provider} size={18} />
                <span className={AGENT_UI[agentId].color}>{AGENT_UI[agentId].name}</span>
              </span>
            ))}
            {typingAgents.length > 3 && <span className="text-ink-500">+{typingAgents.length - 3}</span>}
            <span className="text-ink-500">typing...</span>
            <span className="typing-indicator ml-2">
              <span className="typing-dot" />
              <span className="typing-dot" />
              <span className="typing-dot" />
            </span>
          </div>
        </div>
      )}
    </div>
  );
}


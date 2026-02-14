import { useCallback, useEffect, useMemo, useRef } from "react";
import { Council, type CouncilEvent } from "@socratic-council/core";
import { DEFAULT_AGENTS } from "@socratic-council/shared";
import type { AgentConfig, AgentId as CouncilAgentId, ModelId, ProviderCredentials } from "@socratic-council/shared";
import { apiLogger, callProvider, type ChatMessage as APIChatMessage } from "../services/api";
import { createTauriTransport } from "../services/tauriTransport";
import { useConfig, type Provider } from "../stores/config";
import { useCouncilSessionStore } from "../stores/councilSession";
import { useAgentResponse } from "./useAgentResponse";
import { getToolPrompt } from "../services/tools";

const GROUP_CHAT_GUIDELINES = `
You are in a real-time group chat. Keep responses short and engaging.

Rules:
- 1–2 short paragraphs (max ~140 words).
- Avoid headings and long bullet lists (keep it chatty). Use them only if plain text is clearly insufficient.
- Directly address a specific point from someone else by name.
- Add exactly one new claim, example, or counterpoint; don’t restate your thesis.
- End with one concrete question to the group.
- If the Moderator gives an instruction, follow it.

Markdown:
- Markdown is supported (GFM tables, links, **bold**, \`code\`, fenced code blocks, and LaTeX math via $...$ / $$...$$).
- Prefer plain text for normal conversations. Use Markdown only when it materially improves clarity (math, CS, structured data).
- If you use math/code, write the real formula/code (not placeholders).

Quoting/Reactions:
- Use @quote(MSG_ID) exactly where you want the quote to appear. You can quote multiple messages.
- If it fits, include @react(MSG_ID, EMOJI).

${getToolPrompt()}
`;

const MODERATOR_SYSTEM_PROMPT = `You are the Moderator in a group chat with George, Cathy, Grace, Douglas, and Kate.

Your job: keep the discussion focused, fair, and readable.

Rules:
- Speak rarely and briefly (1–2 sentences, max ~70 words).
- Prefer plain text. Use Markdown only if plain text is clearly insufficient.
- Ask at most ONE question.
- You may suggest who should respond next by name.
- Do NOT include @quote(...), @react(...), or @tool(...).
- Do NOT impersonate any agent.`;

function buildCouncilCredentials(credentials: ReturnType<typeof useConfig>["config"]["credentials"]): ProviderCredentials {
  const result: ProviderCredentials = {};
  for (const [provider, credential] of Object.entries(credentials) as Array<[Provider, { apiKey: string; baseUrl?: string }]> ) {
    if (!credential?.apiKey) continue;
    (result as Record<string, unknown>)[provider] = {
      apiKey: credential.apiKey,
      ...(credential.baseUrl ? { baseUrl: credential.baseUrl } : {}),
    };
  }
  return result;
}

function buildCouncilAgents(models: Record<string, string | undefined>): Record<CouncilAgentId, AgentConfig> {
  const agents = Object.fromEntries(
    Object.entries(DEFAULT_AGENTS).map(([id, agent]) => [id, { ...agent }])
  ) as Record<CouncilAgentId, AgentConfig>;
  for (const agent of Object.values(agents)) {
    const modelOverride = models[agent.provider];
    if (modelOverride) {
      agent.model = modelOverride as ModelId;
    }

    agent.systemPrompt = `${agent.systemPrompt}\n\n${GROUP_CHAT_GUIDELINES}`.trim();
  }
  return agents;
}

type ModeratorRuntime = {
  provider: Provider;
  model: string;
  apiKey: string;
  baseUrl?: string;
};

function pickModeratorRuntime(config: ReturnType<typeof useConfig>["config"]): ModeratorRuntime | null {
  if (!config.preferences.moderatorEnabled) return null;
  const order: Provider[] = ["openai", "anthropic", "google", "deepseek", "kimi"];
  for (const provider of order) {
    const credential = config.credentials[provider];
    const model = config.models[provider];
    if (credential?.apiKey && model) {
      return {
        provider,
        model,
        apiKey: credential.apiKey,
        baseUrl: credential.baseUrl,
      };
    }
  }
  return null;
}

export function useCouncilSession(topic: string) {
  const { config, getMaxTurns, getConfiguredProviders, getProxy } = useConfig();
  const maxTurns = getMaxTurns();
  const configuredProviders = getConfiguredProviders();
  const proxy = getProxy();

  const councilRef = useRef<Council | null>(null);
  const hasStartedRef = useRef(false);
  const moderatorInFlightRef = useRef(false);
  const lastWhisperKeyRef = useRef<string | null>(null);
  const lastModeratorKeyRef = useRef<string | null>(null);
  const moderatorDisplayByIdRef = useRef(new Map<string, { provider: Provider }>());

  const transport = useMemo(
    () =>
      createTauriTransport({
        proxy,
        logger: (level, message, details) => apiLogger.log(level, "transport", message, details),
      }),
    [proxy]
  );

  const getModeratorDisplay = useCallback((messageId: string) => {
    const info = moderatorDisplayByIdRef.current.get(messageId);
    if (!info) return null;
    return { displayName: "Moderator", displayProvider: info.provider };
  }, []);

  const generateModeratorMessage = useCallback(
    async (options: { kind: "opening" | "tension"; conflictKey?: string }): Promise<void> => {
      if (moderatorInFlightRef.current) return;
      if (!config.preferences.moderatorEnabled) return;

      const runtime = pickModeratorRuntime(config);
      if (!runtime) return;

      if (options.kind === "tension" && options.conflictKey) {
        if (lastModeratorKeyRef.current === options.conflictKey) return;
        lastModeratorKeyRef.current = options.conflictKey;
      }

      const council = councilRef.current;
      if (!council) return;

      moderatorInFlightRef.current = true;
      try {
        const id = `msg_${Date.now()}_moderator_${Math.random().toString(36).slice(2, 7)}`;
        moderatorDisplayByIdRef.current.set(id, { provider: runtime.provider });

        const history: APIChatMessage[] = [
          { role: "system", content: MODERATOR_SYSTEM_PROMPT },
          { role: "user", content: `Discussion topic: \"${topic}\"` },
        ];

        if (options.kind === "tension") {
          const recent = useCouncilSessionStore
            .getState()
            .messages.filter((m) => !m.isStreaming && (m.content ?? "").trim().length > 0)
            .slice(-12);

          for (const msg of recent) {
            const speaker =
              typeof msg.displayName === "string" && msg.displayName.trim()
                ? msg.displayName
                : msg.agentId === "user"
                  ? "User"
                  : msg.agentId === "tool"
                    ? "Tool"
                    : msg.agentId === "system"
                      ? "System"
                      : String(msg.agentId);
            history.push({
              role: "user",
              content: `${speaker} (id: ${msg.id}): ${msg.content}`,
            });
          }
        }

        if (options.kind === "opening") {
          history.push({
            role: "user",
            content:
              "Write the opening moderator message (1–2 sentences). Re-state the topic in plain language and ask one concrete kickoff question.",
          });
        } else {
          history.push({
            role: "user",
            content:
              "Write a short tension note (1–2 sentences). Identify the disagreement at a high level and suggest who should respond next by name. Ask at most one question.",
          });
        }

        const result = await callProvider(
          runtime.provider,
          { apiKey: runtime.apiKey, baseUrl: runtime.baseUrl },
          runtime.model,
          history,
          () => {},
          proxy,
          {
            idleTimeoutMs: 60000,
            requestTimeoutMs: 90000,
          }
        );

        const content = (result.content ?? "").trim();
        if (!content) return;

        council.addExternalMessage({
          id,
          agentId: "system",
          content,
          timestamp: Date.now(),
          metadata: result.success
            ? {
                model: runtime.model as ModelId,
                latencyMs: result.latencyMs,
              }
            : undefined,
        });
      } finally {
        moderatorInFlightRef.current = false;
      }
    },
    [config, proxy, topic]
  );

  const { onEvent: baseOnEvent } = useAgentResponse({
    getModeratorDisplay,
    showBiddingScores: config.preferences.showBiddingScores,
  });

  const onEvent = useCallback(
    (event: CouncilEvent) => {
      baseOnEvent(event);

      const council = councilRef.current;
      if (!council) return;

      if (event.type === "conflict_detected") {
        const key = event.conflict.agentPair.join("-");
        if (lastWhisperKeyRef.current !== key) {
          lastWhisperKeyRef.current = key;
          const [from, to] = event.conflict.agentPair;
          council.sendWhisper(from, to, {
            type: "strategy",
            payload: {
              proposedAction: "Press the counterpoint and tighten the argument.",
              bidBonus: 8,
            },
          });
        }

        if (config.preferences.moderatorEnabled) {
          void generateModeratorMessage({ kind: "tension", conflictKey: key });
        }
      }
    },
    [baseOnEvent, config.preferences.moderatorEnabled, generateModeratorMessage]
  );

  const stop = useCallback(() => {
    councilRef.current?.stop();
    councilRef.current = null;
    useCouncilSessionStore.getState().setTypingAgents([]);
    useCouncilSessionStore.getState().setIsPaused(false);
    useCouncilSessionStore.getState().setIsRunning(false);
  }, []);

  const pauseResume = useCallback(async () => {
    const council = councilRef.current;
    if (!council) return;
    const store = useCouncilSessionStore.getState();

    if (store.isPaused) {
      store.setIsPaused(false);
      await council.resume();
      return;
    }

    council.pause();
    store.removeStreamingMessages();
    store.setTypingAgents([]);
    store.setIsPaused(true);
  }, []);

  const start = useCallback(async () => {
    if (hasStartedRef.current) return;

    useCouncilSessionStore.getState().reset();
    hasStartedRef.current = true;

    const credentials = buildCouncilCredentials(config.credentials);
    const agents = buildCouncilAgents(config.models);
    const council = new Council(credentials, { topic, maxTurns, autoMode: true }, agents, { transport });
    council.onEvent(onEvent);
    councilRef.current = council;

    // If moderator is enabled, defer auto-start until the opening note is added.
    await council.start(topic, { deferAutoStart: config.preferences.moderatorEnabled });
    if (config.preferences.moderatorEnabled) {
      await generateModeratorMessage({ kind: "opening" });
      await council.startAutoMode();
    }
  }, [config.credentials, config.models, config.preferences.moderatorEnabled, generateModeratorMessage, maxTurns, onEvent, topic, transport]);

  useEffect(() => {
    if (hasStartedRef.current) return;

    if (configuredProviders.length > 0) {
      void start();
      return;
    }

    const store = useCouncilSessionStore.getState();
    if (store.messages.length === 0) {
      store.setMessages([
        {
          id: `msg_${Date.now()}`,
          agentId: "system",
          content:
            "No API keys configured. Please go to Settings and configure at least one provider to start the discussion.",
          timestamp: Date.now(),
          error: "No API keys configured",
          displayName: "System",
        },
      ]);
    }
  }, [configuredProviders.length, start]);

  useEffect(() => {
    return () => {
      stop();
    };
  }, [stop]);

  return {
    stop,
    pauseResume,
  };
}

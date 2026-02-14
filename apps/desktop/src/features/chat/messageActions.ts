import { REACTION_CATALOG } from "../../components/icons/ReactionIcons";
import type { ChatMessage } from "../../stores/councilSession";

const ACTION_PATTERNS = {
  quote: /@quote\(([^)]+)\)/g,
  react: /@react\(([^,]+),\s*([^)]+)\)/g,
};

function normalizeMessageText(raw: string): string {
  return raw
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export type ExtractedReaction = { targetId: string; emoji: string };

export function extractMessageActions(raw: string): {
  cleaned: string;
  quoteTargets: string[];
  reactions: ExtractedReaction[];
} {
  const reactions: ExtractedReaction[] = [];
  const quoteTargets: string[] = [];

  let cleaned = raw;

  cleaned = cleaned.replace(ACTION_PATTERNS.quote, (_, target) => {
    const targetId = String(target).trim();
    if (!quoteTargets.includes(targetId)) quoteTargets.push(targetId);
    // Preserve token (position matters for inline quote rendering)
    return `@quote(${targetId})`;
  });

  cleaned = cleaned.replace(ACTION_PATTERNS.react, (_, target, emoji) => {
    const reaction = String(emoji).trim();
    if (REACTION_CATALOG.includes(reaction)) {
      reactions.push({ targetId: String(target).trim(), emoji: reaction });
    }
    return "";
  });

  return {
    cleaned: normalizeMessageText(cleaned),
    quoteTargets,
    reactions,
  };
}

export function applyReactions(
  items: ChatMessage[],
  reactions: ExtractedReaction[],
  actorId: string
): ChatMessage[] {
  if (reactions.length === 0) return items;

  return items.map((message) => {
    const matches = reactions.filter((reaction) => reaction.targetId === message.id);
    if (matches.length === 0) return message;

    const nextReactions = { ...(message.reactions ?? {}) } as Record<
      string,
      { count: number; by: string[] }
    >;

    for (const reaction of matches) {
      const existing = nextReactions[reaction.emoji] ?? { count: 0, by: [] };
      if (!existing.by.includes(actorId)) {
        existing.by = [...existing.by, actorId];
        existing.count += 1;
      }
      nextReactions[reaction.emoji] = existing;
    }

    return { ...message, reactions: nextReactions };
  });
}


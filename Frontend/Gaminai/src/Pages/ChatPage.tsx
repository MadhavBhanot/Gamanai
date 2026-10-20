import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import type { User } from '@supabase/supabase-js';
import {
  BarChart3,
  ChevronDown,
  ExternalLink,
  LogOut,
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  Plus,
  Search,
  SendHorizontal,
  Sparkles,
  Square,
  Telescope,
  ThumbsDown,
  ThumbsUp,
  Trash2,
} from 'lucide-react';
import { Link, useNavigate } from 'react-router';
import BrandBadge from '../components/BrandBadge';
import MarkdownText, { hideBrokenImage } from '../components/MarkdownText';
import ImageModal from '../components/ImageModal';
import { isSupabaseConfigured, supabase } from '../lib/supabaseClient';
import { isGuestMode } from '../lib/guest';
import { API_BASE_URL } from '../lib/api';


type MessageRole = 'user' | 'assistant' | 'system';
type SourceStatus = 'loading' | 'ready';

type ChatMessage = {
  id: string;
  role: MessageRole;
  content: string;
  rawContent?: string;
  thinkContent?: string;
  researchSteps?: string[]; // deep mode: one line per agent search, shown in the thinking trace
  mode?: 'quick' | 'deep';
  status?: 'streaming' | 'complete' | 'error';
};

type ConversationSummary = {
  id: string;
  title: string;
  preview: string;
  updatedAt: string;
};

type ConversationMessageRecord = {
  id?: string | number;
  role?: string;
  content?: string;
  createdAt?: string;
};

type SourceItem = {
  id: string;
  title: string;
  url: string;
  domain: string;
  favicon: string;
  snippet: string;
  status: SourceStatus;
};

type FollowUp = {
  id: string;
  label: string;
};

type StreamLog = {
  id: string;
  label: string;
  detail: string;
};

type ThinkingPhaseState = 'pending' | 'active' | 'complete';

type ThinkingPhase = {
  id: string;
  label: string;
  state: ThinkingPhaseState;
};

type AssistantParts = {
  answer: string;
  followups: string[];
  nextSteps: string[];
  thinkContent: string;
};

type StreamEvent =
  | { type: 'delta'; text: string }
  | { type: 'source'; source: Partial<SourceItem> & { url?: string } }
  | { type: 'sources'; sources: Array<Partial<SourceItem> & { url?: string }> }
  | { type: 'followups'; followups: string[] }
  | { type: 'status'; label: string; detail?: string; conversationId?: string }
  | { type: 'done' }
  | { type: 'error'; message: string };

const initialMessages: ChatMessage[] = [];

// Empty-state starters, one per feature worth showing a first-time visitor
const STARTERS: Array<{ text: string; mode: 'quick' | 'deep'; hint: string }> = [
  { text: 'Who won the 2024 Nobel Prize in Physics, and for what?', mode: 'quick', hint: 'Cited answer' },
  { text: 'Who directed the 2024 Best Picture winner, and what was their previous film?', mode: 'deep', hint: 'Multi-step research' },
  { text: 'Summarize https://react.dev/blog in three bullet points', mode: 'quick', hint: 'Reads a URL' },
  { text: 'Show me photos of the first James Webb Space Telescope images', mode: 'quick', hint: 'Verified images' },
];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const getString = (value: unknown, fallback = '') => (typeof value === 'string' ? value : fallback);

const makeId = (prefix: string) => `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;

const domainFromUrl = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url.replace(/^https?:\/\//, '').split('/')[0] || 'source';
  }
};

const faviconFor = (url: string) => {
  const domain = domainFromUrl(url);
  return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=64`;
};

const normalizeSource = (source: Partial<SourceItem> & { url?: string }): SourceItem | null => {
  const url = getString(source.url);

  if (!url) {
    return null;
  }

  const domain = getString(source.domain, domainFromUrl(url));

  return {
    id: getString(source.id, url),
    title: getString(source.title, domain),
    url,
    domain,
    favicon: getString(source.favicon, faviconFor(url)),
    snippet: getString(source.snippet) || getString((source as Record<string, unknown>).content),
    status: source.status ?? 'ready',
  };
};

const cleanListItem = (value: string) =>
  value
    .replace(/<\/?question>/gi, '')
    .replace(/<\/?(?:ANSWER|FOLLOW_UPS|think)>/gi, '')
    .replace(/^(?:follow[-\u2010-\u2015\s]?ups?(?:\s+questions?)?|suggested\s+prompts?|next\s+steps?)\s*:?\s*/i, '')
    .replace(/^\s*[-*]\s+/, '')
    .replace(/^\s*\d+[\).\s-]*/, '')
    .replace(/^["'“”]+|["'“”]+$/g, '')
    .trim();

const listItemsFromBlock = (block: string, questionsOnly = false) => {
  const normalized = block
    .replace(/<\/?FOLLOW_UPS>/gi, '')
    .replace(/<\/?question>/gi, '\n')
    .replace(/<\/?[A-Z_]+>/gi, '\n')
    .replace(/\|\s*\|/g, '\n');
  const candidates = normalized
    .split(/\r?\n\s*\r?\n|\r?\n|(?<=\?)\s+(?=\d+[\).\s-]|\w)|(?<=[.!])\s+(?=\d+[\).\s-])/)
    .map(cleanListItem)
    .filter(Boolean);

  return candidates.filter((item, index, array) => {
    if (array.indexOf(item) !== index) {
      return false;
    }

    if (questionsOnly) {
      return item.length > 8;
    }

    return item.length > 5;
  });
};

const extractTaggedQuestions = (block: string) =>
  Array.from(block.matchAll(/<question\b[^>]*>\s*([\s\S]*?)\s*(?:<\/question>|(?=<question\b)|(?=<\/FOLLOW_UPS>)|$)/gi))
    .map((match) => cleanListItem(match[1]))
    .filter(Boolean);

const extractThinkSection = (rawContent: string) => {
  const openMatch = rawContent.match(/<think>/i);

  if (!openMatch || openMatch.index === undefined) {
    return {
      thinkContent: '',
      contentWithoutThink: rawContent,
    };
  }

  const thinkStart = openMatch.index;
  const thinkBodyStart = thinkStart + openMatch[0].length;
  const remainder = rawContent.slice(thinkBodyStart);
  const closeMatch = remainder.match(/<\/think>/i);

  if (!closeMatch || closeMatch.index === undefined) {
    return {
      thinkContent: remainder.trim(),
      contentWithoutThink: rawContent.slice(0, thinkStart),
    };
  }

  const thinkEnd = thinkBodyStart + closeMatch.index;
  const afterThinkIndex = thinkEnd + closeMatch[0].length;

  return {
    thinkContent: rawContent.slice(thinkBodyStart, thinkEnd).trim(),
    contentWithoutThink: `${rawContent.slice(0, thinkStart)}${rawContent.slice(afterThinkIndex)}`,
  };
};

// The backend appends <CITATIONS>[{url,title},...]</CITATIONS> after the answer; [n] in the text means entry n.
const CITATIONS_PATTERN = /<CITATIONS>([\s\S]*?)(?:<\/CITATIONS>|$)/i;

const parseCitations = (rawContent: string): Array<{ url: string; title: string }> => {
  const json = rawContent.match(CITATIONS_PATTERN)?.[1];
  if (!json) return [];
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed)
      ? parsed.filter(isRecord).map((c) => ({ url: getString(c.url), title: getString(c.title) }))
      : [];
  } catch {
    return []; // still streaming or malformed: leave [n] as plain text
  }
};

/** Turn [n] markers into markdown links to their source; MarkdownText renders numeric links as citation chips. */
const linkCitations = (answer: string, citations: Array<{ url: string; title: string }>) =>
  citations.length
    ? answer.replace(/\[(\d{1,2})\](?!\()/g, (marker, n: string) => {
        const source = citations[Number(n) - 1];
        return source?.url.startsWith('http') ? `[${n}](${source.url})` : marker;
      })
    : answer;

const stripAssistantNoise = (value: string) =>
  value
    .replace(CITATIONS_PATTERN, '')
    .replace(/(?:^|\n)\s*(?:Reasoning trace|Reasoning|Analysis|Thoughts?|Thinking trace|Final answer)\s*:?\s*(?=\n|$)/gi, '\n')
    .replace(/^(?:Reasoning trace|Reasoning|Analysis|Thoughts?|Thinking trace|Final answer)\s*:?\s*/i, '')
    .replace(/\n{3,}/g, '\n\n');

const cleanAssistantDisplayContent = (value: string) =>
  stripAssistantNoise(value)
    .replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, ' ')
    .replace(/<\/?ANSWER>/gi, ' ')
    .replace(/<\/?FOLLOW_UPS>/gi, ' ')
    .replace(/<\/?question>/gi, ' ')
    .replace(/<\/?[A-Z_]+>/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const extractAssistantParts = (rawContent: string): AssistantParts => {
  const parts = extractAssistantSections(rawContent);
  return { ...parts, answer: linkCitations(parts.answer, parseCitations(rawContent)) };
};

const extractAssistantSections = (rawContent: string): AssistantParts => {
  const { thinkContent, contentWithoutThink } = extractThinkSection(rawContent);
  const sanitizedContent = stripAssistantNoise(contentWithoutThink).trim();
  const xmlFollowUpStart = sanitizedContent.search(/<FOLLOW_UPS>/i);
  const sectionPattern =
    /(?:^|\n)\s*(?:-{3,}\s*)?(?:#{1,4}\s*)?(Follow[-\u2010-\u2015\s]?Ups?(?:\s+Questions?)?|Suggested\s+(?:Prompts?|Questions?|Next\s+Steps?)|Next\s+Steps?)\s*:?\s*(?:\n|$)/gi;

  if (xmlFollowUpStart === -1 && !sectionPattern.test(sanitizedContent)) {
    const answer = sanitizedContent
      .replace(/<\/?ANSWER>/gi, '')
      .replace(/<\/?(ANSW?E?R?)>?$/gi, '')
      .trim();
    return { answer, followups: [], nextSteps: [], thinkContent };
  }

  sectionPattern.lastIndex = 0;

  const sections = Array.from(sanitizedContent.matchAll(sectionPattern)).map((match) => ({
    index: match.index,
    label: match[1].toLowerCase(),
    markerLength: match[0].length,
  }));

  if (xmlFollowUpStart >= 0 && !sections.some((section) => section.label.includes('follow'))) {
    sections.push({
      index: xmlFollowUpStart,
      label: 'follow-ups',
      markerLength: '<FOLLOW_UPS>'.length,
    });
  }

  sections.sort((a, b) => a.index - b.index);

  const answerEnd = sections[0]?.index ?? sanitizedContent.length;
  const answer = sanitizedContent
    .slice(0, answerEnd)
    .replace(/<\/?ANSWER>/gi, '')
    .replace(/<\/?FOLLOW_UPS>/gi, '')
    .replace(/<\/?question>/gi, '')
    .replace(/\n\s*-{3,}\s*$/g, '')
    .replace(/<\/?(ANSW?E?R?|FOLLOW_?U?P?S?|questi?o?n?)>?$/gi, '')
    .trim();

  let followups: string[] = [];
  let nextSteps: string[] = [];

  sections.forEach((section, index) => {
    const sectionStart = section.index + section.markerLength;
    const sectionEnd = sections[index + 1]?.index ?? sanitizedContent.length;
    const block = sanitizedContent.slice(sectionStart, sectionEnd);

    if (section.label.includes('follow')) {
      const taggedQuestions = extractTaggedQuestions(block);
      followups = taggedQuestions.length ? taggedQuestions : listItemsFromBlock(block, true);
    }

    if (section.label.includes('next')) {
      nextSteps = listItemsFromBlock(block);
    }
  });

  return { answer, followups, nextSteps, thinkContent };
};

const collectArray = (payload: unknown, keys: string[]) => {
  if (!isRecord(payload)) {
    return [];
  }

  for (const key of keys) {
    const value = payload[key];

    if (Array.isArray(value)) {
      return value;
    }
  }

  return [];
};

const normalizeConversations = (payload: unknown): ConversationSummary[] => {
  const records = Array.isArray(payload)
    ? payload
    : collectArray(payload, ['conversations', 'items', 'data', 'results']);

  return records.filter(isRecord).map((item, index) => {
    const title =
      getString(item.title) ||
      getString(item.name) ||
      getString(item.topic) ||
      `Conversation ${index + 1}`;
    const previewSource =
      getString(item.preview) || getString(item.summary) || getString(item.lastMessage);
    const previewRole =
      getString(item.previewRole) || getString(item.lastMessageRole) || getString(item.role);
    const updatedAt =
      getString(item.updatedAt) ||
      getString(item.updated_at) ||
      getString(item.lastMessageCreatedAt) ||
      getString(item.createdAt) ||
      '';

    return {
      id: getString(item.id, String(index + 1)),
      title,
      preview: summarizeConversationPreview(previewSource, previewRole),
      updatedAt,
    };
  });
};

const normalizeConversationMessages = (
  payload: unknown,
): { messages: ChatMessage[]; followups: string[]; nextSteps: string[] } => {
  const records = collectArray(payload, ['messages', 'items', 'data']);
  const nextMessages: ChatMessage[] = [];
  let latestFollowups: string[] = [];
  let latestNextSteps: string[] = [];

  for (const item of records.filter(isRecord) as ConversationMessageRecord[]) {
    const rawRole = getString(item.role).toLowerCase();
    const role: MessageRole = rawRole === 'user' ? 'user' : rawRole === 'system' ? 'system' : 'assistant';
    const rawContent = getString(item.content);

    if (!rawContent) {
      continue;
    }

    if (role === 'assistant') {
      const { answer, followups, nextSteps, thinkContent } = extractAssistantParts(rawContent);
      latestFollowups = followups.length ? followups : latestFollowups;
      latestNextSteps = nextSteps.length ? nextSteps : latestNextSteps;
      nextMessages.push({
        id: String(item.id ?? makeId('loaded-assistant')),
        role,
        content: answer || cleanAssistantDisplayContent(rawContent),
        rawContent,
        thinkContent,
        status: 'complete',
      });
      continue;
    }

    nextMessages.push({
      id: String(item.id ?? makeId('loaded-user')),
      role,
      content: rawContent,
      status: 'complete',
    });
  }

  return {
    messages: nextMessages.length ? nextMessages : initialMessages,
    followups: latestFollowups,
    nextSteps: latestNextSteps,
  };
};

const parseJson = (value: string): unknown => {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
};

const textFromAiDataLine = (payload: string) => {
  const parsed = parseJson(payload);

  if (typeof parsed === 'string') {
    return parsed;
  }

  return payload;
};

const normalizePayloadEvents = (payload: unknown): StreamEvent[] => {
  if (typeof payload === 'string') {
    return [{ type: 'delta', text: payload }];
  }

  if (Array.isArray(payload)) {
    return payload.flatMap((item) => normalizePayloadEvents(item));
  }

  if (!isRecord(payload)) {
    return [];
  }

  const type = getString(payload.type) || getString(payload.event);
  const text = getString(payload.text) || getString(payload.delta) || getString(payload.content);
  const message = getString(payload.message) || getString(payload.answer);
  const error = getString(payload.error);
  const conversationId = getString(payload.conversationId);
  const sources = collectArray(payload, ['sources', 'citations', 'references']);
  const followups = collectArray(payload, ['followups', 'followUps', 'questions', 'suggestions'])
    .map((item) =>
      typeof item === 'string'
        ? item
        : isRecord(item)
          ? getString(item.label) || getString(item.question) || getString(item.text) || getString(item.content)
          : '',
    )
    .filter(Boolean);

  if (type === 'web_result' && isRecord(payload.data)) {
    return [{ type: 'source', source: payload.data as Partial<SourceItem> & { url?: string } }];
  }

  if (type === 'ai_chunk') {
    return [{ type: 'delta', text }];
  }

  if (type === 'web_end') {
    return [{ type: 'status', label: 'Web search complete', detail: 'Sources loaded.', conversationId }];
  }

  if (type === 'response_start') {
    return [{ type: 'status', label: 'Model response started', detail: 'Streaming answer.', conversationId }];
  }

  if (type === 'response_end') {
    return [{ type: 'done' }];
  }

  if (type === 'source' || type === 'citation') {
    return [{ type: 'source', source: payload as Partial<SourceItem> & { url?: string } }];
  }

  if (type === 'sources') {
    return [{ type: 'sources', sources: sources as Array<Partial<SourceItem> & { url?: string }> }];
  }

  if (type === 'followup' || type === 'followups' || type === 'questions') {
    return [{ type: 'followups', followups: followups.length ? followups : [message || text].filter(Boolean) }];
  }

  if (type === 'status' || type === 'progress') {
    return [{ type: 'status', label: getString(payload.label) || message || text || 'Working', detail: getString(payload.detail), conversationId }];
  }

  if (type === 'error') {
    return [{ type: 'error', message: error || message || text || 'Stream error' }];
  }

  const events: StreamEvent[] = [];

  if (text || message) {
    events.push({ type: 'delta', text: text || message });
  }

  if (sources.length) {
    events.push({ type: 'sources', sources: sources as Array<Partial<SourceItem> & { url?: string }> });
  }

  if (followups.length) {
    events.push({ type: 'followups', followups });
  }

  return events;
};

const parseStreamLine = (line: string): StreamEvent[] => {
  let payload = line.trim();

  if (!payload) {
    return [];
  }

  if (payload.startsWith(':')) {
    return [];
  }

  if (payload.startsWith('data:')) {
    payload = payload.slice(5).trim();
  }

  if (payload === '[DONE]') {
    return [{ type: 'done' }];
  }

  const aiDataMatch = payload.match(/^([a-z0-9]+):(.*)$/i);

  if (aiDataMatch) {
    const [, channel, value] = aiDataMatch;

    if (channel === '0') {
      return [{ type: 'delta', text: textFromAiDataLine(value) }];
    }

    const parsed = parseJson(value);
    return normalizePayloadEvents(parsed ?? value);
  }

  const parsed = parseJson(payload);
  return parsed ? normalizePayloadEvents(parsed) : [{ type: 'delta', text: payload }];
};

const formatDate = (value: string) => {
  if (!value) {
    return 'Recent';
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  const now = new Date();
  const isSameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();

  return new Intl.DateTimeFormat(
    undefined,
    isSameDay
      ? {
          hour: 'numeric',
          minute: '2-digit',
        }
      : {
          month: 'short',
          day: 'numeric',
        },
  ).format(date);
};

const startsWide = () =>
  typeof window === 'undefined' ? true : window.matchMedia('(min-width: 1181px)').matches;

const STREAM_RENDER_DEBOUNCE_MS = 110;
const CONVERSATION_PREVIEW_MAX_CHARS = 24;

const summarizeConversationPreview = (value: string, role = '') => {
  const normalizedRole = role.toLowerCase();
  const rawPreview = normalizedRole === 'assistant' ? extractAssistantParts(value).answer || cleanAssistantDisplayContent(value) : value;
  const collapsed = rawPreview.replace(/\s+/g, ' ').trim();

  if (collapsed.length <= CONVERSATION_PREVIEW_MAX_CHARS) {
    return collapsed;
  }

  return `${collapsed.slice(0, CONVERSATION_PREVIEW_MAX_CHARS - 1).trimEnd()}…`;
};

const splitStreamingTraceLines = (value: string) =>
  value
    .replace(/\r\n/g, '\n')
    .split('\n')
    .flatMap((line) =>
      line
        .split(/(?<=[.!?])\s+(?=[A-Z0-9"'`(])/)
        .map((segment) => segment.trim()),
    )
    .filter(Boolean);

const PlainTextStream = ({
  content,
  className,
}: {
  content: string;
  className: string;
}) => (
  <div className={className}>
    {content}
  </div>
);

const AssistantMessageBody = ({
  message,
  onImageClick,
}: {
  message: ChatMessage;
  onImageClick?: (src: string, alt?: string) => void;
}) => {
  const researchSteps = message.researchSteps ?? [];
  const hasThinkContent = Boolean(message.thinkContent?.trim()) || researchSteps.length > 0;
  const [isThinkOpen, setIsThinkOpen] = useState(false);

  const liveThinkLines = useMemo(
    () => [...researchSteps, ...splitStreamingTraceLines(message.thinkContent ?? '')].slice(-5),
    [researchSteps, message.thinkContent],
  );

  useEffect(() => {
    if (!hasThinkContent) {
      setIsThinkOpen(false);
    }
  }, [hasThinkContent]);

  useEffect(() => {
    setIsThinkOpen(false);
  }, [message.id]);

  const answerContent =
    message.content || (message.status === 'streaming' && !hasThinkContent ? 'Listening to the stream...' : '');

  return (
    <>
      {hasThinkContent ? (
        <section className={`message-think ${isThinkOpen ? 'is-open' : 'is-collapsed'} ${message.status === 'streaming' ? 'is-live' : ''}`}>
          <button
            aria-expanded={isThinkOpen}
            className="message-think-toggle"
            onClick={() => setIsThinkOpen((current) => !current)}
            type="button"
          >
            <span>
              {researchSteps.length
                ? `Research trace · ${researchSteps.length} step${researchSteps.length === 1 ? '' : 's'}`
                : message.status === 'streaming' ? 'Thinking trace' : 'Reasoning trace'}
            </span>
            <ChevronDown className="collapse-icon" size={14} />
          </button>
          {isThinkOpen ? (
            <div className="message-think-body">
              {researchSteps.length ? (
                <ol className="research-steps">
                  {researchSteps.map((step, index) => (
                    <li key={`${message.id}-step-${index}`}>{step}</li>
                  ))}
                </ol>
              ) : null}
              <PlainTextStream
                className={`message-think-expanded ${message.status === 'streaming' ? 'is-live' : ''}`}
                content={message.thinkContent ?? ''}
              />
            </div>
          ) : liveThinkLines.length ? (
            <div className="message-think-preview" aria-hidden="true">
              {liveThinkLines.map((line, index) => (
                <span className="message-think-line" key={`${message.id}-think-${index}`}>
                  {line}
                </span>
              ))}
            </div>
          ) : null}
        </section>
      ) : null}

      {answerContent ? (
        message.status === 'streaming' ? (
          <PlainTextStream className="message-live-stream is-live" content={answerContent} />
        ) : (
          <MarkdownText content={answerContent} onImageClick={onImageClick} />
        )
      ) : null}
    </>
  );
};

const ChatPage = () => {
  const navigate = useNavigate();
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const chatThreadRef = useRef<HTMLDivElement>(null);
  const [user, setUser] = useState<User | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [isLeftPanelOpen, setIsLeftPanelOpen] = useState(startsWide);
  const [isRightPanelOpen, setIsRightPanelOpen] = useState(startsWide);
  const [isUserMenuOpen, setIsUserMenuOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>(initialMessages);
  const [input, setInput] = useState('');
  const [conversationFilter, setConversationFilter] = useState('');
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [sources, setSources] = useState<SourceItem[]>([]);
  const [sourcesByConversation, setSourcesByConversation] = useState<Record<string, SourceItem[]>>({});
  const [followUps, setFollowUps] = useState<FollowUp[]>([]);
  const [nextSteps, setNextSteps] = useState<FollowUp[]>([]);
  const [selectedImage, setSelectedImage] = useState<{ src: string; alt?: string } | null>(null);
  const lastLoadedConversationIdRef = useRef<string | null>(null);
  const [streamLog, setStreamLog] = useState<StreamLog[]>([
    {
      id: 'idle',
      label: 'Agent idle',
      detail: 'Submit a prompt to begin a streamed run.',
    },
  ]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamingConversationId, setStreamingConversationId] = useState<string | null>(null);
  const [isLoadingConversation, setIsLoadingConversation] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [sourcesCollapsed, setSourcesCollapsed] = useState(false);
  const [suggestedPromptsCollapsed, setSuggestedPromptsCollapsed] = useState(false);
  // Deep research: the backend plans several searches before answering, streamed as "Research step" statuses
  const [deepMode, setDeepMode] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const [openConversationMenuId, setOpenConversationMenuId] = useState<string | null>(null);
  const [conversationPendingDelete, setConversationPendingDelete] =
    useState<ConversationSummary | null>(null);
  const [isDeletingConversation, setIsDeletingConversation] = useState(false);
  const activeConversationRef = useRef<string | null>(null);
  const streamedAssistantIdsRef = useRef<Set<string>>(new Set());
  const pendingAssistantTextRef = useRef('');
  const pendingAssistantMessageIdRef = useRef<string | null>(null);
  const streamFlushTimerRef = useRef<number | null>(null);
  const scrollFrameRefs = useRef<number[]>([]);
  const latestAssistantPreviewRef = useRef('');
  const assistantRawContentByIdRef = useRef<Record<string, string>>({});

  // Guests (no sign-in) can chat too; they get single-shot answers via /api/AI/guest
  const canChat = Boolean(user) || isGuestMode();
  const isEmptyChat = messages.length === 0 && !isLoadingConversation;
  const canSubmit = Boolean(canChat && input.trim() && (!isStreaming || streamingConversationId !== activeConversationId));

  const firstName = useMemo(() => {
    if (!user?.email) {
      return 'Builder';
    }

    return user.email.split('@')[0];
  }, [user]);

  const userProfile = useMemo(() => {
    const metadata = user?.user_metadata ?? {};
    const name = getString(metadata.full_name) || getString(metadata.name) || firstName;
    const avatar = getString(metadata.avatar_url) || getString(metadata.picture);
    const email = user?.email ?? '';

    return {
      avatar,
      email,
      initial: (name || email || 'G').slice(0, 1).toUpperCase(),
      name,
    };
  }, [firstName, user]);

  const filteredConversations = useMemo(() => {
    const query = conversationFilter.trim().toLowerCase();

    if (!query) {
      return conversations;
    }

    return conversations.filter((conversation) =>
      `${conversation.title} ${conversation.preview}`.toLowerCase().includes(query),
    );
  }, [conversationFilter, conversations]);

  const activeConversation = useMemo(
    () => conversations.find((conversation) => conversation.id === activeConversationId) ?? null,
    [activeConversationId, conversations],
  );

  useEffect(() => {
    if (!openConversationMenuId) {
      return;
    }

    const handlePointerDown = (event: MouseEvent) => {
      if (event.target instanceof Element && event.target.closest('.conversation-card-actions')) {
        return;
      }

      setOpenConversationMenuId(null);
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpenConversationMenuId(null);
      }
    };

    window.addEventListener('pointerdown', handlePointerDown);
    window.addEventListener('keydown', handleKeyDown);

    return () => {
      window.removeEventListener('pointerdown', handlePointerDown);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [openConversationMenuId]);

  useEffect(() => {
    if (!conversationPendingDelete) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !isDeletingConversation) {
        setConversationPendingDelete(null);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [conversationPendingDelete, isDeletingConversation]);

  const sourceDomains = useMemo(
    () => Array.from(new Set(sources.map((source) => source.domain))).slice(0, 6),
    [sources],
  );

  const latestUserPrompt = useMemo(
    () => [...messages].reverse().find((message) => message.role === 'user')?.content ?? 'No prompt yet.',
    [messages],
  );

  const chatTitle =
    activeConversation?.title ?? (latestUserPrompt === 'No prompt yet.' ? 'New research' : latestUserPrompt);
  const suggestedPrompts = followUps.length ? followUps : nextSteps;
  const suggestedPromptSummary = followUps.length
    ? 'Suggested prompts you can send next.'
    : nextSteps.length
      ? 'Continue this thread with one quick action.'
      : isStreaming
        ? 'Suggested prompts are being prepared.'
        : 'Suggested prompts appear after each answer.';
  const recentStreamEvents = useMemo(() => streamLog.slice(0, 4), [streamLog]);
  const thinkingPhases = useMemo<ThinkingPhase[]>(() => {
    const logText = recentStreamEvents
      .flatMap((event) => [event.label, event.detail])
      .join(' ')
      .toLowerCase();
    const hasStarted = logText.includes('agent run started');
    const hasSources =
      logText.includes('source attached') ||
      logText.includes('sources refreshed') ||
      logText.includes('web search complete');
    const hasDraft = logText.includes('model response started') || logText.includes('answer streaming');
    const hasPrompts = logText.includes('suggested prompts ready') || suggestedPrompts.length > 0;
    const hasCompleted = logText.includes('agent run complete') || logText.includes('model response complete');
    const activeKey = isStreaming ? (hasPrompts ? 'prompts' : hasDraft ? 'draft' : 'sources') : null;

    const phaseState = (id: 'sources' | 'draft' | 'prompts'): ThinkingPhaseState => {
      if (id === 'sources') {
        if (hasSources || hasDraft || hasPrompts || hasCompleted) {
          return activeKey === id ? 'active' : 'complete';
        }

        return activeKey === id ? 'active' : 'pending';
      }

      if (id === 'draft') {
        if (hasDraft || hasPrompts || hasCompleted) {
          return activeKey === id ? 'active' : 'complete';
        }

        return activeKey === id ? 'active' : 'pending';
      }

      if (hasPrompts || hasCompleted) {
        return activeKey === id ? 'active' : 'complete';
      }

      return activeKey === id ? 'active' : 'pending';
    };

    return [
      {
        id: 'queued',
        label: 'Queued',
        state: hasStarted || isStreaming || hasCompleted ? 'complete' : 'pending',
      },
      { id: 'sources', label: 'Researching', state: phaseState('sources') },
      { id: 'draft', label: 'Writing', state: phaseState('draft') },
      { id: 'prompts', label: 'Prompts', state: phaseState('prompts') },
    ];
  }, [isStreaming, recentStreamEvents, suggestedPrompts.length]);
  const streamStatusLabel = useMemo(() => {
    const activePhase = thinkingPhases.find((phase) => phase.state === 'active');

    if (activePhase) {
      return activePhase.label;
    }

    if (!isStreaming && recentStreamEvents[0]?.label === 'Agent idle') {
      return 'Idle';
    }

    return recentStreamEvents[0]?.label ?? 'Idle';
  }, [isStreaming, recentStreamEvents, thinkingPhases]);

  const scrollChatToBottom = (behavior: ScrollBehavior = 'auto') => {
    const scroll = () => {
      const el = chatThreadRef.current;
      if (!el) {
        return;
      }

      el.scrollTo({ top: el.scrollHeight, behavior });
    };

    scroll();
    scrollFrameRefs.current.forEach((frameId) => window.cancelAnimationFrame(frameId));
    scrollFrameRefs.current = [];
    const firstFrame = window.requestAnimationFrame(() => {
      scroll();
      const secondFrame = window.requestAnimationFrame(() => {
        scroll();
        scrollFrameRefs.current = [];
      });
      scrollFrameRefs.current = [secondFrame];
    });
    scrollFrameRefs.current = [firstFrame];
  };

  // Auto-scroll chat thread to bottom when messages change
  useEffect(() => {
    if (!chatThreadRef.current) {
      return;
    }

    scrollChatToBottom();
  }, [messages]);

  useEffect(
    () => () => {
      if (streamFlushTimerRef.current !== null) {
        window.clearTimeout(streamFlushTimerRef.current);
      }
      scrollFrameRefs.current.forEach((frameId) => window.cancelAnimationFrame(frameId));
      scrollFrameRefs.current = [];
    },
    [],
  );

  useEffect(() => {
    activeConversationRef.current = activeConversationId;
  }, [activeConversationId]);

  useEffect(() => {
    let isMounted = true;

    if (!isSupabaseConfigured) {
      setAuthReady(true);
      return () => {
        isMounted = false;
      };
    }

    async function hydrateAuth() {
      const {
        data: { user: currentUser },
        error,
      } = await supabase.auth.getUser();

      if (!isMounted) {
        return;
      }

      if (!error) {
        setUser(currentUser);
      }

      setAuthReady(true);

      // Redirect to auth if no user (guests may stay)
      if (!currentUser && !isGuestMode()) {
        navigate('/auth');
      }
    }

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      const currentUser = session?.user ?? null;
      setUser(currentUser);
      setAuthReady(true);
      if (!currentUser && !isGuestMode()) {
        navigate('/auth');
      }
    });

    hydrateAuth();

    return () => {
      isMounted = false;
      subscription.unsubscribe();
    };
  }, [navigate]);

  useEffect(() => {
    const media = window.matchMedia('(min-width: 1181px)');
    const syncPanels = (event: MediaQueryListEvent | MediaQueryList) => {
      setIsLeftPanelOpen(event.matches);
      setIsRightPanelOpen(event.matches);
    };

    syncPanels(media);
    media.addEventListener('change', syncPanels);

    return () => {
      media.removeEventListener('change', syncPanels);
    };
  }, []);

  useEffect(() => {
    if (!user) {
      setConversations([]);
      setActiveConversationId(null);
      return;
    }

    let isMounted = true;

    async function loadConversations() {
      try {
        const jwt = await getAccessToken();
        const response = await fetch(`${API_BASE_URL}/api/conversations`, {
          headers: jwt ? { Authorization: `Bearer ${jwt}` } : undefined,
        });

        if (!response.ok) {
          throw new Error(`Conversation load failed with ${response.status}`);
        }

        const payload: unknown = await response.json();
        const normalized = normalizeConversations(payload);

        if (isMounted) {
          setConversations(normalized);
          setActiveConversationId((current) =>
            current && normalized.some((conversation) => conversation.id === current)
              ? current
              : null,
          );
        }
      } catch (error) {
        if (isMounted) {
          addStreamLog('Conversation sync paused', error instanceof Error ? error.message : 'Unknown error');
        }
      }
    }

    loadConversations();

    return () => {
      isMounted = false;
    };
  }, [user]);

  useEffect(() => {
    if (!user || !activeConversationId || isStreaming) {
      return;
    }

    if (activeConversationId === lastLoadedConversationIdRef.current) {
      return;
    }

    let isMounted = true;

    async function loadConversationDetail() {
      setIsLoadingConversation(true);

      try {
        const jwt = await getAccessToken();
        const response = await fetch(`${API_BASE_URL}/api/conversations/${activeConversationId}`, {
          headers: jwt ? { Authorization: `Bearer ${jwt}` } : undefined,
        });

        if (!response.ok) {
          throw new Error(`Conversation load failed with ${response.status}`);
        }

        const payload: unknown = await response.json();
        const normalized = normalizeConversationMessages(payload);

        if (!isMounted) {
          return;
        }

        setMessages(normalized.messages);
        setSuggestedFollowUps(normalized.followups);
        setSuggestedNextSteps(normalized.nextSteps);
        addStreamLog('Memory loaded', activeConversation?.title ?? activeConversationId ?? '');
      } catch (error) {
        if (isMounted) {
          addStreamLog('Memory load failed', error instanceof Error ? error.message : 'Unknown error');
        }
      } finally {
        if (isMounted) {
          setIsLoadingConversation(false);
          lastLoadedConversationIdRef.current = activeConversationId;
        }
      }
    }

    loadConversationDetail();

    return () => {
      isMounted = false;
    };
  }, [activeConversationId, isStreaming, user]);

  useEffect(() => {
    if (!activeConversationId) {
      setSources([]);
      return;
    }

    setSources(sourcesByConversation[activeConversationId] ?? []);
  }, [activeConversationId, sourcesByConversation]);

  // Thumbs up/down: stored server-side with the question and answer text, so guest answers can be rated too
  const [ratings, setRatings] = useState<Record<string, 1 | -1>>({});
  const rateAnswer = async (message: ChatMessage, question: string, rating: 1 | -1) => {
    setRatings((current) => ({ ...current, [message.id]: rating }));
    try {
      const response = await fetch(`${API_BASE_URL}/api/feedback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          rating,
          query: question,
          answer: message.content.slice(0, 20000),
          mode: message.mode,
          conversationId: activeConversationId ?? undefined,
        }),
      });
      if (!response.ok) throw new Error(`Feedback failed with ${response.status}`);
    } catch {
      // Let the user try again rather than showing a vote that wasn't saved
      setRatings(({ [message.id]: _dropped, ...rest }) => rest);
    }
  };

  const getAccessToken = async () => {
    if (!isSupabaseConfigured) {
      return null;
    }

    const {
      data: { session },
    } = await supabase.auth.getSession();

    return session?.access_token ?? null;
  };

  const addStreamLog = (label: string, detail = '') => {
    setStreamLog((current) => [
      {
        id: makeId('log'),
        label,
        detail,
      },
      ...current.slice(0, 7),
    ]);
  };

  const upsertConversationSummary = (summary: ConversationSummary) => {
    setConversations((current) => {
      const existing = current.find((conversation) => conversation.id === summary.id);
      const nextSummary: ConversationSummary = {
        id: summary.id,
        title: summary.title || existing?.title || 'New research',
        preview: summary.preview || existing?.preview || '',
        updatedAt: summary.updatedAt || existing?.updatedAt || '',
      };

      return [nextSummary, ...current.filter((conversation) => conversation.id !== summary.id)];
    });
  };

  const resetWorkspaceState = (label = 'New chat ready', detail = 'Ask a fresh research question.') => {
    setActiveConversationId(null);
    activeConversationRef.current = null;
    lastLoadedConversationIdRef.current = null;
    setMessages(initialMessages);
    setSources([]);
    setFollowUps([]);
    setNextSteps([]);
    setSuggestedPromptsCollapsed(false);
    setInput('');
    setErrorMessage('');
    streamedAssistantIdsRef.current.clear();
    assistantRawContentByIdRef.current = {};
    setStreamLog([
      {
        id: makeId('workspace'),
        label,
        detail,
      },
    ]);
  };

  const appendAssistantText = (messageId: string, text: string) => {
    if (!text) {
      return;
    }

    if (text.trim() && !streamedAssistantIdsRef.current.has(messageId)) {
      streamedAssistantIdsRef.current.add(messageId);
      addStreamLog('Answer streaming', 'Drafting a response from the gathered context.');
    }

    const rawContent = `${assistantRawContentByIdRef.current[messageId] ?? ''}${text}`;
    assistantRawContentByIdRef.current[messageId] = rawContent;
    const { answer, followups: discoveredFollowups, nextSteps: discoveredNextSteps, thinkContent } =
      extractAssistantParts(rawContent);
    const displayContent = answer || cleanAssistantDisplayContent(rawContent);
    const latestPreview = summarizeConversationPreview(displayContent, 'assistant');

    setMessages((current) =>
      current.map((message) =>
        message.id === messageId
          ? {
              ...message,
              rawContent,
              thinkContent,
              content: displayContent,
            }
          : message,
      ),
    );
    scrollChatToBottom();

    if (latestPreview) {
      latestAssistantPreviewRef.current = latestPreview;
    }

    if (discoveredFollowups.length) {
      setSuggestedFollowUps(discoveredFollowups);
    }

    if (discoveredNextSteps.length) {
      setSuggestedNextSteps(discoveredNextSteps);
    }
  };

  const finalizeAssistantText = (messageId: string) => {
    const rawContent = assistantRawContentByIdRef.current[messageId];

    if (!rawContent) {
      return null;
    }

    const { answer, followups: discoveredFollowups, nextSteps: discoveredNextSteps, thinkContent } =
      extractAssistantParts(rawContent);
    const displayContent = answer || cleanAssistantDisplayContent(rawContent);
    latestAssistantPreviewRef.current = summarizeConversationPreview(displayContent, 'assistant');

    setMessages((current) =>
      current.map((message) =>
        message.id === messageId
          ? {
              ...message,
              rawContent,
              thinkContent,
              content: displayContent,
            }
          : message,
      ),
    );
    scrollChatToBottom();

    if (discoveredFollowups.length) {
      setSuggestedFollowUps(discoveredFollowups);
      addStreamLog(
        'Suggested prompts ready',
        `${discoveredFollowups.length} prompt${discoveredFollowups.length === 1 ? '' : 's'}`,
      );
    }

    if (discoveredNextSteps.length) {
      setSuggestedNextSteps(discoveredNextSteps);
    }

    return {
      rawContent,
      thinkContent,
      content: displayContent,
    };
  };

  const flushPendingAssistantText = () => {
    const messageId = pendingAssistantMessageIdRef.current;
    const text = pendingAssistantTextRef.current;

    if (!messageId || !text) {
      return;
    }

    pendingAssistantMessageIdRef.current = null;
    pendingAssistantTextRef.current = '';
    appendAssistantText(messageId, text);
  };

  const queueAssistantText = (messageId: string, text: string) => {
    if (!text) {
      return;
    }

    if (
      pendingAssistantMessageIdRef.current &&
      pendingAssistantMessageIdRef.current !== messageId
    ) {
      flushPendingAssistantText();
    }

    pendingAssistantMessageIdRef.current = messageId;
    pendingAssistantTextRef.current += text;

    if (streamFlushTimerRef.current !== null) {
      return;
    }

    streamFlushTimerRef.current = window.setTimeout(() => {
      streamFlushTimerRef.current = null;
      flushPendingAssistantText();
      scrollChatToBottom();
    }, STREAM_RENDER_DEBOUNCE_MS);
  };

  const upsertSources = (incoming: Array<Partial<SourceItem> & { url?: string }>) => {
    const normalized = incoming.map(normalizeSource).filter((source): source is SourceItem => Boolean(source));

    if (!normalized.length) {
      return;
    }

    setSources((current) => {
      const next = [...current];

      for (const source of normalized) {
        const index = next.findIndex((item) => item.id === source.id || item.url === source.url);

        if (index >= 0) {
          next[index] = { ...next[index], ...source, status: 'ready' };
        } else {
          next.push(source);
        }
      }

      const conversationId = activeConversationRef.current;
      if (conversationId) {
        setSourcesByConversation((cache) => ({
          ...cache,
          [conversationId]: next,
        }));
      }

      return next;
    });
  };

  const setSuggestedFollowUps = (questions: string[]) => {
    const normalized = questions
      .map((label) => label.trim())
      .filter(Boolean)
      .slice(0, 4)
      .map((label) => ({ id: makeId('followup'), label }));

    setFollowUps(normalized);
  };

  const setSuggestedNextSteps = (steps: string[]) => {
    const normalized = steps
      .map((label) => label.trim())
      .filter(Boolean)
      .slice(0, 5)
      .map((label) => ({ id: makeId('next'), label }));

    setNextSteps(normalized);
  };

  const handleStreamEvent = (event: StreamEvent, assistantId: string) => {
    if (event.type === 'delta') {
      queueAssistantText(assistantId, event.text);
      return;
    }

    if (event.type === 'source') {
      upsertSources([event.source]);
      addStreamLog('Source attached', getString(event.source.title) || getString(event.source.url));
      return;
    }

    if (event.type === 'sources') {
      upsertSources(event.sources);
      addStreamLog('Sources refreshed', `${event.sources.length} source${event.sources.length === 1 ? '' : 's'}`);
      return;
    }

    if (event.type === 'followups') {
      setSuggestedFollowUps(event.followups);
      addStreamLog(
        'Suggested prompts ready',
        `${event.followups.length} prompt${event.followups.length === 1 ? '' : 's'}`,
      );
      return;
    }

    if (event.type === 'status') {
      if (event.conversationId) {
        setActiveConversationId(event.conversationId);
        activeConversationRef.current = event.conversationId;
        lastLoadedConversationIdRef.current = event.conversationId;
      }
      addStreamLog(event.label, event.detail);
      if (/^(Planning research|Research step)/.test(event.label)) {
        const line = event.detail ? `${event.label}: ${event.detail}` : event.label;
        setMessages((current) =>
          current.map((m) => (m.id === assistantId ? { ...m, researchSteps: [...(m.researchSteps ?? []), line] } : m)),
        );
      }
      return;
    }

    if (event.type === 'done') {
      addStreamLog('Model response complete', 'The stream closed normally.');
      return;
    }

    if (event.type === 'error') {
      throw new Error(event.message);
    }
  };

  const readStream = async (response: Response, assistantId: string) => {
    const reader = response.body?.getReader();

    if (!reader) {
      const payload: unknown = await response.json();
      normalizePayloadEvents(payload).forEach((event) => handleStreamEvent(event, assistantId));
      return;
    }

    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      const chunk = decoder.decode(value, { stream: true });
      // A chunk starting with ':' is an SSE keep-alive comment, not answer text
      const isStructured =
        chunk.includes('data:') || /^\s*([a-z0-9]+)?:/i.test(chunk) || chunk.trim().startsWith('{');

      if (!isStructured && !buffer) {
        queueAssistantText(assistantId, chunk);
        continue;
      }

      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        parseStreamLine(line).forEach((event) => handleStreamEvent(event, assistantId));
      }
    }

    if (buffer.trim()) {
      parseStreamLine(buffer).forEach((event) => handleStreamEvent(event, assistantId));
    }
  };

  // `mode` is a parameter so a starter can pick Deep without waiting for the toggle's state update
  const runPrompt = async (promptText: string, mode: 'quick' | 'deep' = deepMode ? 'deep' : 'quick') => {
    const prompt = promptText.trim();

    if (!prompt || (isStreaming && streamingConversationId === activeConversationId)) {
      return;
    }

    const isGuest = !user && isGuestMode();
    if (!user && !isGuest) {
      navigate('/auth');
      return;
    }

    // Guests get single-shot answers: nothing is persisted server-side to follow up on.
    const isFollowUp = !isGuest && Boolean(activeConversationId);
    const userMessage: ChatMessage = {
      id: makeId('user'),
      role: 'user',
      content: prompt,
      status: 'complete',
    };
    const assistantId = makeId('assistant');

    setMessages((current) => [
      ...current,
      userMessage,
      {
        id: assistantId,
        role: 'assistant',
        content: '',
        status: 'streaming',
        mode,
      },
    ]);
    scrollChatToBottom('smooth');
    setInput('');
    setErrorMessage('');
    setIsStreaming(true);
    setStreamingConversationId(activeConversationId);
    pendingAssistantTextRef.current = '';
    pendingAssistantMessageIdRef.current = null;
    latestAssistantPreviewRef.current = '';
    assistantRawContentByIdRef.current[assistantId] = '';
    if (streamFlushTimerRef.current !== null) {
      window.clearTimeout(streamFlushTimerRef.current);
      streamFlushTimerRef.current = null;
    }
    setSources((current) => (isFollowUp ? current.map((source) => ({ ...source, status: 'loading' })) : []));
    setFollowUps([]);
    setNextSteps([]);
    setSuggestedPromptsCollapsed(false);
    addStreamLog('Agent run started', prompt);
    const requestStartedAt = new Date().toISOString();

    if (isFollowUp && activeConversationId) {
      upsertConversationSummary({
        id: activeConversationId,
        title: activeConversation?.title ?? prompt.slice(0, 80),
        preview: summarizeConversationPreview(prompt, 'user'),
        updatedAt: requestStartedAt,
      });
    }

    // Stop button: aborting the fetch closes the stream, and the backend stops its model calls when it sees that
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const jwt = await getAccessToken();
      const endpoint = isGuest ? '/api/AI/guest' : isFollowUp ? '/api/AI/follow_up' : '/api/AI';
      const response = await fetch(`${API_BASE_URL}${endpoint}`, {
        signal: controller.signal,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(jwt ? { Authorization: `Bearer ${jwt}` } : {}),
        },
        body: JSON.stringify(
          isFollowUp
            ? {
                conversationId: activeConversationId,
                query: prompt,
                mode,
              }
            : {
                query: prompt,
                mode,
              },
        ),
      });

      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw new Error(body?.error ?? `Agent request failed with ${response.status}`);
      }

      const responseConversationId = response.headers.get('X-Conversation-ID');
      if (responseConversationId) {
        setActiveConversationId(responseConversationId);
        activeConversationRef.current = responseConversationId;
        lastLoadedConversationIdRef.current = responseConversationId;
        upsertConversationSummary({
          id: responseConversationId,
          title: prompt.slice(0, 80),
          preview: summarizeConversationPreview(prompt, 'user'),
          updatedAt: requestStartedAt,
        });
      }

      await readStream(response, assistantId);
      flushPendingAssistantText();
      const finalizedAssistant = finalizeAssistantText(assistantId);
      if (activeConversationRef.current) {
        lastLoadedConversationIdRef.current = activeConversationRef.current;
        upsertConversationSummary({
          id: activeConversationRef.current,
          title: activeConversation?.title ?? prompt.slice(0, 80),
          preview:
            latestAssistantPreviewRef.current || summarizeConversationPreview(prompt, 'user'),
          updatedAt: new Date().toISOString(),
        });
      }
      setMessages((current) =>
        current.map((message) =>
          message.id === assistantId
            ? {
                ...message,
                ...(finalizedAssistant ?? {}),
                status: 'complete',
              }
            : message,
        ),
      );
      addStreamLog('Agent run complete', 'Answer, sources, and suggested prompts are ready.');
    } catch (error) {
      flushPendingAssistantText();
      if (controller.signal.aborted) {
        // Keep whatever was written before Stop instead of showing an error
        finalizeAssistantText(assistantId);
        setMessages((current) =>
          current.map((chatMessage) =>
            chatMessage.id === assistantId
              ? { ...chatMessage, status: 'complete', content: chatMessage.content || '_Stopped before an answer was written._' }
              : chatMessage,
          ),
        );
        addStreamLog('Agent run stopped', 'Stopped by you.');
        return;
      }
      const message = error instanceof Error ? error.message : 'Unknown stream failure';
      setErrorMessage(message);
      setMessages((current) =>
        current.map((chatMessage) =>
          chatMessage.id === assistantId
            ? {
                ...chatMessage,
                status: 'error',
                content:
                  chatMessage.content ||
                  'The agent stream could not be completed. Check the backend endpoint and try again.',
              }
            : chatMessage,
        ),
      );
      addStreamLog('Agent run failed', message);
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      setSources((current) => current.map((source) => ({ ...source, status: 'ready' })));
      setIsStreaming(false);
      setStreamingConversationId(null);
    }
  };

  const submitPrompt = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    scrollChatToBottom('smooth');
    void runPrompt(input);
  };

  const applyFollowUp = (question: string) => {
    setInput(question);
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  const sendFollowUp = (question: string) => {
    setInput('');
    scrollChatToBottom('smooth');
    void runPrompt(question);
  };

  const openSource = (source?: SourceItem) => {
    if (!source) {
      return;
    }

    window.open(source.url, '_blank', 'noreferrer');
  };

  const selectConversation = (conversationId: string) => {
    if (isStreaming) return;
    setOpenConversationMenuId(null);
    setActiveConversationId(conversationId);

    if (!startsWide()) {
      setIsLeftPanelOpen(false);
    }
  };

  const requestDeleteConversation = (conversation: ConversationSummary) => {
    if (isStreaming || isDeletingConversation) {
      return;
    }

    setOpenConversationMenuId(null);
    setConversationPendingDelete(conversation);
  };

  const closeDeleteConversationModal = () => {
    if (isDeletingConversation) {
      return;
    }

    setConversationPendingDelete(null);
  };

  const confirmDeleteConversation = async () => {
    if (!conversationPendingDelete || isDeletingConversation) {
      return;
    }

    setIsDeletingConversation(true);
    setErrorMessage('');

    try {
      const jwt = await getAccessToken();
      const response = await fetch(
        `${API_BASE_URL}/api/conversations/${conversationPendingDelete.id}`,
        {
          method: 'DELETE',
          headers: jwt ? { Authorization: `Bearer ${jwt}` } : undefined,
        },
      );

      if (!response.ok && response.status !== 204) {
        throw new Error(`Conversation delete failed with ${response.status}`);
      }

      const deletedConversation = conversationPendingDelete;
      const remainingConversations = conversations.filter(
        (conversation) => conversation.id !== deletedConversation.id,
      );

      setConversations(remainingConversations);
      setSourcesByConversation((current) => {
        const next = { ...current };
        delete next[deletedConversation.id];
        return next;
      });

      if (activeConversationId === deletedConversation.id) {
        resetWorkspaceState(
          'Conversation deleted',
          'The thread was removed from memory. Start a new chat when ready.',
        );
      }

      if (activeConversationId !== deletedConversation.id) {
        addStreamLog('Conversation deleted', deletedConversation.title || 'Chat removed from memory.');
      }
      setConversationPendingDelete(null);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Conversation delete failed.');
    } finally {
      setIsDeletingConversation(false);
    }
  };

  const startNewChat = () => {
    if (isStreaming) return;
    setOpenConversationMenuId(null);
    setConversationPendingDelete(null);
    resetWorkspaceState();

    if (!startsWide()) {
      setIsLeftPanelOpen(false);
    }
  };

  const signOut = async () => {
    if (isSupabaseConfigured) {
      await supabase.auth.signOut();
    }

    setOpenConversationMenuId(null);
    setConversationPendingDelete(null);
    setUser(null);
    setIsUserMenuOpen(false);
    setMessages(initialMessages);
    navigate('/auth');
  };

  return (
    <main
      className={`workspace ${isLeftPanelOpen ? '' : 'is-left-collapsed'} ${
        isRightPanelOpen ? '' : 'is-right-collapsed'
      }`}
    >
      <aside className="conversation-rail" aria-label="Conversation history">
        <div className="rail-header">
          <Link className="brand-lockup" to="/">
            <BrandBadge className="brand-svg" />
            <span>Gaminai</span>
          </Link>
          <div className="rail-actions">
            <button
              aria-label="Collapse conversation panel"
              className="panel-icon icon-only"
              onClick={() => setIsLeftPanelOpen(false)}
              title="Collapse conversation panel"
              type="button"
            >
              <PanelLeftClose aria-hidden="true" size={16} />
            </button>
          </div>
        </div>

        <label className="thread-search">
          <span>Search threads</span>
          <div className="thread-search-control">
            <Search aria-hidden="true" size={16} />
            <input
              onChange={(event) => setConversationFilter(event.target.value)}
              placeholder="Search memory"
              type="search"
              value={conversationFilter}
            />
          </div>
        </label>

        <div className="rail-section">
          <div className="section-heading">
            <div className="memory-heading">
              <p className="eyebrow">Memory</p>
              <span>{filteredConversations.length}</span>
            </div>
            <button className="panel-icon panel-icon-inline" onClick={startNewChat} type="button">
              <Plus aria-hidden="true" size={15} />
              <span>New chat</span>
            </button>
          </div>
          <div className="conversation-list">
            {filteredConversations.length ? (
              filteredConversations.map((conversation) => (
                <div className="conversation-card-shell" key={conversation.id}>
                  <button
                    className={`conversation-card ${
                      activeConversationId === conversation.id ? 'is-active' : ''
                    }`}
                    onClick={() => selectConversation(conversation.id)}
                    type="button"
                  >
                    <span className="conversation-card-meta">
                      <strong>{conversation.title}</strong>
                      <small>{formatDate(conversation.updatedAt)}</small>
                    </span>
                    {conversation.preview ? <span>{conversation.preview}</span> : null}
                  </button>
                  <div className="conversation-card-actions">
                    <button
                      aria-expanded={openConversationMenuId === conversation.id}
                      aria-label={`Open actions for ${conversation.title}`}
                      className="panel-icon icon-only conversation-card-menu-button"
                      disabled={isStreaming || isDeletingConversation}
                      onClick={(event) => {
                        event.stopPropagation();
                        setOpenConversationMenuId((current) =>
                          current === conversation.id ? null : conversation.id,
                        );
                      }}
                      title="Conversation actions"
                      type="button"
                    >
                      <MoreHorizontal aria-hidden="true" size={12} />
                    </button>
                    {openConversationMenuId === conversation.id ? (
                      <div className="conversation-card-menu" role="menu">
                        <button
                          className="conversation-card-menu-item danger"
                          onClick={(event) => {
                            event.stopPropagation();
                            requestDeleteConversation(conversation);
                          }}
                          role="menuitem"
                          type="button"
                        >
                          <Trash2 aria-hidden="true" size={12} />
                          <span>Delete chat</span>
                        </button>
                      </div>
                    ) : null}
                  </div>
                </div>
              ))
            ) : (
              <div className="empty-block">
                <strong>No matching threads</strong>
                <span>{user ? 'Try a different search.' : 'Sign in to sync memory.'}</span>
              </div>
            )}
          </div>
        </div>


      </aside>

      {conversationPendingDelete ? (
        <div
          className="modal-backdrop"
          onClick={closeDeleteConversationModal}
          role="presentation"
        >
          <section
            aria-labelledby="delete-conversation-title"
            aria-modal="true"
            className="confirm-modal"
            onClick={(event) => event.stopPropagation()}
            role="dialog"
          >
            <div className="confirm-modal-copy">
              <p className="eyebrow">Delete memory</p>
              <h2 id="delete-conversation-title">Delete this conversation?</h2>
              <p>
                This will permanently remove <strong>{conversationPendingDelete.title}</strong> and
                all of its messages from your saved memory.
              </p>
            </div>
            <div className="confirm-modal-actions">
              <button
                className="ghost-button"
                disabled={isDeletingConversation}
                onClick={closeDeleteConversationModal}
                type="button"
              >
                Cancel
              </button>
              <button
                className="solid-button danger-button"
                disabled={isDeletingConversation}
                onClick={() => void confirmDeleteConversation()}
                type="button"
              >
                <Trash2 aria-hidden="true" size={14} />
                <span>{isDeletingConversation ? 'Deleting…' : 'Delete chat'}</span>
              </button>
            </div>
          </section>
        </div>
      ) : null}

      <section className="chat-stage" aria-labelledby="chat-title">
        <header className="topbar">
          <div className="topbar-title">
            <button
              aria-label={isLeftPanelOpen ? 'Hide conversation panel' : 'Show conversation panel'}
              className="panel-icon"
              onClick={() => setIsLeftPanelOpen((current) => !current)}
              title={isLeftPanelOpen ? 'Hide conversation panel' : 'Show conversation panel'}
              type="button"
            >
              {isLeftPanelOpen ? (
                <PanelLeftClose aria-hidden="true" size={16} />
              ) : (
                <PanelLeftOpen aria-hidden="true" size={16} />
              )}
              <span>Threads</span>
            </button>
            <div>
              <p className="eyebrow">Agent workspace</p>
              <h1 id="chat-title">{chatTitle}</h1>
            </div>
          </div>

          <div className="session-actions">
            <Link className="panel-icon" title="How answer quality is measured" to="/evals">
              <BarChart3 aria-hidden="true" size={16} />
              <span>Evals</span>
            </Link>
            <button
              aria-label={isRightPanelOpen ? 'Hide activity panel' : 'Show activity panel'}
              className="panel-icon"
              onClick={() => setIsRightPanelOpen((current) => !current)}
              title={isRightPanelOpen ? 'Hide activity panel' : 'Show activity panel'}
              type="button"
            >
              {isRightPanelOpen ? (
                <PanelRightClose aria-hidden="true" size={16} />
              ) : (
                <PanelRightOpen aria-hidden="true" size={16} />
              )}
              <span>Canvas</span>
            </button>

            {authReady && user ? (
              <div className="user-menu">
                <button
                  aria-expanded={isUserMenuOpen}
                  aria-haspopup="menu"
                  className="avatar-button"
                  onClick={() => setIsUserMenuOpen((current) => !current)}
                  type="button"
                >
                  {userProfile.avatar ? (
                    <img alt="" height="32" src={userProfile.avatar} width="32" />
                  ) : (
                    <span>{userProfile.initial}</span>
                  )}
                  <strong>{userProfile.name}</strong>
                </button>

                {isUserMenuOpen ? (
                  <div className="user-popover" role="menu">
                    <small>Signed in as</small>
                    <strong>{userProfile.email}</strong>
                    <button onClick={signOut} role="menuitem" type="button">
                      <LogOut aria-hidden="true" size={16} />
                      <span>Log out</span>
                    </button>
                  </div>
                ) : null}
              </div>
            ) : (
              <Link className="solid-button" to="/auth">
                Log in
              </Link>
            )}
          </div>
        </header>

        <section className={`answer-window ${isEmptyChat ? 'is-empty' : ''}`} aria-label="Agent response">
          <div className="answer-overlay">
            <section className={`thinking-panel ${isStreaming ? 'is-live' : ''}`} aria-label="Agent thinking">
              <div className="thinking-phase-row">
                {thinkingPhases.map((phase) => (
                  <span className={`thinking-phase ${phase.state}`} key={phase.id} title={phase.label}>
                    <span>{phase.label}</span>
                  </span>
                ))}
              </div>
            </section>

            <div className={`inline-sources ${sourcesCollapsed ? 'is-collapsed' : ''}`}>
              <div className="section-heading" onClick={() => setSourcesCollapsed(c => !c)}>
                <p className="eyebrow">Sources</p>
                <span style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  {sources.length}
                  <ChevronDown className="collapse-icon" size={14} />
                </span>
              </div>
              <div className="source-carousel" aria-label="Source carousel">
                {sources.length ? (
                  sources.map((source) => (
                    <a
                      className={`source-pill ${source.status}`}
                      href={source.url}
                      key={source.id}
                      rel="noreferrer"
                      target="_blank"
                      title={source.url}
                    >
                      <img alt="" height="24" onError={hideBrokenImage} src={source.favicon} width="24" />
                      <span className="source-pill-copy">
                        <span className="source-pill-heading">
                          <strong>{source.title}</strong>
                          <ExternalLink aria-hidden="true" size={13} />
                        </span>
                        <small>{source.domain}</small>
                      </span>
                    </a>
                  ))
                ) : (
                  <div className={isStreaming ? 'source-placeholder is-loading' : 'source-placeholder'}>
                    <span>
                      {isStreaming
                        ? 'Collecting sources...'
                        : 'Sources appear here when the agent cites them.'}
                    </span>
                  </div>
                )}
              </div>
            </div>
          </div>

          <div className="chat-thread" ref={chatThreadRef} aria-live="polite">
            {isLoadingConversation ? (
              <article className="message system">
                <span className="message-role">Memory</span>
                <p>Loading the selected chat...</p>
              </article>
            ) : null}
            {isEmptyChat ? (
              <section className="empty-state" aria-labelledby="empty-title">
                <BrandBadge alt="" aria-hidden="true" className="empty-state-badge" />
                <h2 id="empty-title">Ask anything. Get an answer with sources.</h2>
                <p>
                  Gaminai searches the web, reads the pages and answers with numbered citations you can check.
                  Switch to <strong>Deep</strong> for questions that need several searches.
                </p>
                <div className="starter-grid">
                  {STARTERS.map((starter) => (
                    <button
                      key={starter.text}
                      onClick={() => {
                        setDeepMode(starter.mode === 'deep');
                        void runPrompt(starter.text, starter.mode);
                      }}
                      type="button"
                    >
                      <small>
                        {starter.mode === 'deep' ? <Telescope aria-hidden="true" size={12} /> : <Sparkles aria-hidden="true" size={12} />}
                        {starter.hint}
                        {starter.mode === 'deep' ? ' · Deep' : ''}
                      </small>
                      <span>{starter.text}</span>
                    </button>
                  ))}
                </div>
                <Link className="empty-state-link" to="/evals">How answer quality is measured →</Link>
              </section>
            ) : null}
            {messages.map((message, index) => {
              const question = messages[index - 1]?.role === 'user' ? messages[index - 1].content : '';
              const canRate = message.role === 'assistant' && message.status === 'complete' && question && message.content;
              return (
                <article className={`message ${message.role}`} key={message.id}>
                  <span className="message-role">{message.role === 'user' ? 'You' : 'Gaminai'}</span>
                  {message.role === 'assistant' ? (
                    <AssistantMessageBody message={message} onImageClick={(src, alt) => setSelectedImage({ src, alt })} />
                  ) : (
                    <p>{message.content}</p>
                  )}
                  {message.status === 'streaming' ? <span className="typing-bar" /> : null}
                  {canRate ? (
                    <div className="message-feedback">
                      {([1, -1] as const).map((rating) => (
                        <button
                          aria-label={rating === 1 ? 'Good answer' : 'Bad answer'}
                          aria-pressed={ratings[message.id] === rating}
                          className={ratings[message.id] === rating ? 'is-active' : ''}
                          disabled={message.id in ratings}
                          key={rating}
                          onClick={() => void rateAnswer(message, question, rating)}
                          title={rating === 1 ? 'Good answer' : 'Bad answer: helps us build test cases'}
                          type="button"
                        >
                          {rating === 1 ? <ThumbsUp aria-hidden="true" size={14} /> : <ThumbsDown aria-hidden="true" size={14} />}
                        </button>
                      ))}
                    </div>
                  ) : null}
                </article>
              );
            })}
          </div>

          {suggestedPrompts.length > 0 && !suggestedPromptsCollapsed && (
            <section className="inline-followups bottom-followups" aria-label="Suggested prompts">
              <div className="followup-strip">
                {suggestedPrompts.map((question) => (
                  <button
                    disabled={isStreaming && streamingConversationId === activeConversationId}
                    key={question.id}
                    onClick={() => sendFollowUp(question.label)}
                    type="button"
                  >
                    <Sparkles aria-hidden="true" size={12} />
                    <span>{question.label}</span>
                  </button>
                ))}
              </div>
            </section>
          )}

        </section>

        {errorMessage ? <p className="form-error">{errorMessage}</p> : null}

        <div className="composer-island">
          {isStreaming ? (
            <BrandBadge alt="" aria-hidden="true" className="composer-stream-loader" />
          ) : null}
          <form className="composer" onSubmit={submitPrompt}>
            <textarea
              aria-label="Message Gaminai"
              disabled={!canChat || (isStreaming && streamingConversationId === activeConversationId)}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  if (canSubmit) void runPrompt(input);
                }
              }}
              placeholder={canChat ? 'Ask Gaminai anything...' : 'Log in to start.'}
              ref={inputRef}
              rows={1}
              value={input}
            />
            {suggestedPrompts.length > 0 ? (
              <button
                aria-expanded={!suggestedPromptsCollapsed}
                aria-label={suggestedPromptsCollapsed ? 'Show suggested prompts' : 'Hide suggested prompts'}
                className={`composer-toggle ${suggestedPromptsCollapsed ? 'is-collapsed' : ''}`}
                onClick={() => setSuggestedPromptsCollapsed((current) => !current)}
                title={suggestedPromptsCollapsed ? 'Show suggested prompts' : 'Hide suggested prompts'}
                type="button"
              >
                <ChevronDown aria-hidden="true" size={16} />
              </button>
            ) : null}
            <button
              aria-pressed={deepMode}
              className={`composer-mode ${deepMode ? 'is-deep' : ''}`}
              onClick={() => setDeepMode((current) => !current)}
              title={deepMode ? 'Deep research: plans several searches before answering' : 'Quick: one search, fastest answer'}
              type="button"
            >
              <Telescope aria-hidden="true" size={14} />
              <span>{deepMode ? 'Deep' : 'Quick'}</span>
            </button>
            {isStreaming && streamingConversationId === activeConversationId ? (
              <button
                aria-label="Stop generating"
                className="composer-send is-stop"
                onClick={() => abortRef.current?.abort()}
                title="Stop generating"
                type="button"
              >
                <Square aria-hidden="true" fill="currentColor" size={12} />
              </button>
            ) : (
              <button aria-label="Send" className="composer-send" disabled={!canSubmit} type="submit">
                <SendHorizontal aria-hidden="true" size={16} />
              </button>
            )}
          </form>
        </div>
      </section>

      <aside className="insight-panel" aria-label="Research canvas">
        <div className="rail-header">
          <div>
            <p className="eyebrow">Canvas</p>
            <h2>Research map</h2>
          </div>
          <button
            aria-label="Collapse activity panel"
            className="panel-icon icon-only"
            onClick={() => setIsRightPanelOpen(false)}
            title="Collapse activity panel"
            type="button"
          >
            <PanelRightClose aria-hidden="true" size={16} />
          </button>
        </div>

        <section className="focus-card" aria-label="Current research focus">
          <p className="eyebrow">Focus</p>
          <strong>{chatTitle}</strong>
          <span>{latestUserPrompt}</span>
        </section>

        <section className="run-metrics" aria-label="Run metrics">
          <div>
            <span>Sources</span>
            <strong>{sources.length}</strong>
          </div>
          <div>
            <span>Prompts</span>
            <strong>{suggestedPrompts.length}</strong>
          </div>
          <div>
            <span>Status</span>
            <strong>{streamStatusLabel}</strong>
          </div>
        </section>

        <section className="domain-panel" aria-label="Source domains">
          <div className="section-heading">
            <p className="eyebrow">Source map</p>
            <span>{sourceDomains.length}</span>
          </div>
          <div className="domain-cloud">
            {sourceDomains.length ? (
              sourceDomains.map((domain) => <span key={domain}>{domain}</span>)
            ) : (
              <small>Domains appear as sources stream in.</small>
            )}
          </div>
        </section>

        <section className="next-panel" aria-label="Quick actions">
          <p className="eyebrow">Quick actions</p>
          <button
            disabled={!suggestedPrompts[0] || isStreaming}
            onClick={() => suggestedPrompts[0] && sendFollowUp(suggestedPrompts[0].label)}
            type="button"
          >
            <Sparkles aria-hidden="true" size={15} />
            <span>Run first prompt</span>
          </button>
          <button disabled={!sources[0]} onClick={() => openSource(sources[0])} type="button">
            <ExternalLink aria-hidden="true" size={15} />
            <span>Open strongest source</span>
          </button>
        </section>

      </aside>
    </main>
  );
};

export default ChatPage;

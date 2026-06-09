import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useEffect, useState } from "react";
import type {
  ConversationListItem,
  MessageDto,
  MessageStatus
} from "@repo/contracts";
import {
  AlertCircle,
  CheckCircle2,
  Clock3,
  Inbox,
  Loader2,
  MessageSquare,
  RefreshCw,
  Send,
  Webhook
} from "lucide-react";
import { Link, Navigate, Route, Routes, useParams } from "react-router-dom";
import {
  getApiEndpoint,
  getConversationMessages,
  getEventStreamEndpoint,
  listConversations,
  sendInboundWebhookTest,
  sendOutboundSms
} from "./api.js";

export function App() {
  return (
    <Routes>
      <Route path="/" element={<Dashboard />} />
      <Route path="/conversations/:conversationId" element={<Dashboard />} />
      <Route path="/test" element={<TestConsole />} />
    </Routes>
  );
}

function Dashboard() {
  const queryClient = useQueryClient();
  const { conversationId } = useParams();
  const [manualRefresh, setManualRefresh] = useState(false);
  const conversationsQuery = useQuery({
    queryKey: ["conversations"],
    queryFn: listConversations
  });
  const conversations: ConversationListItem[] = conversationsQuery.data ?? [];
  const activeConversation = conversationId
    ? conversations.find((conversation) => conversation.id === conversationId)
    : null;
  const messagesQuery = useQuery({
    queryKey: ["conversation", conversationId],
    queryFn: () => getConversationMessages(conversationId as string),
    enabled: Boolean(activeConversation)
  });
  useConversationEvents(queryClient);

  if (conversationId && conversationsQuery.isSuccess && !activeConversation) {
    return <Navigate to="/" replace />;
  }

  const refreshing =
    manualRefresh || conversationsQuery.isFetching || messagesQuery.isFetching;

  async function refreshConversations() {
    setManualRefresh(true);

    try {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: ["conversations"]
        }),
        conversationId
          ? queryClient.invalidateQueries({
              queryKey: ["conversation", conversationId]
            })
          : Promise.resolve()
      ]);
    } finally {
      setManualRefresh(false);
    }
  }

  return (
    <main className="shell">
      <aside className="sidebar" aria-label="Conversations">
        <header className="sidebar-header">
          <div>
            <p className="eyebrow">Admin</p>
            <h1>SMS Conversations</h1>
          </div>
          <div className="header-actions">
            <Link
              className="icon-link"
              to="/test"
              title="Open Twilio test console"
              aria-label="Open Twilio test console"
            >
              <Webhook size={18} />
            </Link>
            <button
              className={refreshing ? "icon-button loading" : "icon-button"}
              type="button"
              title="Refresh conversations"
              aria-label="Refresh conversations"
              aria-busy={refreshing}
              disabled={refreshing}
              onClick={() => {
                void refreshConversations();
              }}
            >
              <RefreshCw size={18} />
            </button>
          </div>
        </header>

        {conversationsQuery.isLoading ? (
          <StateLine icon={<Loader2 size={18} />} label="Loading conversations" />
        ) : null}

        {conversationsQuery.isError ? (
          <StateLine
            icon={<AlertCircle size={18} />}
            label="Could not load conversations"
          />
        ) : null}

        {!conversationsQuery.isLoading && conversations.length === 0 ? (
          <StateLine icon={<Inbox size={18} />} label="No conversations yet" />
        ) : null}

        <nav className="conversation-list">
          {refreshing && !conversationsQuery.isLoading ? (
            <RefreshLine label="Refreshing conversations" />
          ) : null}

          {conversations.map((conversation) => (
            <ConversationLink
              key={conversation.id}
              conversation={conversation}
              active={conversation.id === conversationId}
            />
          ))}
        </nav>
      </aside>

      <section className="detail" aria-label="Conversation detail">
        {!conversationId ? <EmptyDetail /> : null}

        {conversationId && messagesQuery.isLoading ? (
          <StateLine icon={<Loader2 size={18} />} label="Loading messages" />
        ) : null}

        {conversationId && messagesQuery.isError ? (
          <StateLine
            icon={<AlertCircle size={18} />}
            label="Could not load this conversation"
          />
        ) : null}

        {messagesQuery.data ? (
          <ConversationDetail
            fromPhone={messagesQuery.data.conversation.fromPhone}
            toPhone={messagesQuery.data.conversation.toPhone}
            messages={messagesQuery.data.messages}
          />
        ) : null}
      </section>
    </main>
  );
}

function useConversationEvents(queryClient: ReturnType<typeof useQueryClient>) {
  useEffect(() => {
    if (typeof EventSource === "undefined") {
      return undefined;
    }

    const events = new EventSource(getEventStreamEndpoint());
    const handleConversationChanged = (event: MessageEvent<string>) => {
      const conversationId = parseConversationChangedEvent(event.data);

      void queryClient.invalidateQueries({
        queryKey: ["conversations"]
      });
      void queryClient.invalidateQueries({
        queryKey: conversationId
          ? ["conversation", conversationId]
          : ["conversation"]
      });
    };

    events.addEventListener(
      "conversation.changed",
      handleConversationChanged as EventListener
    );

    return () => {
      events.removeEventListener(
        "conversation.changed",
        handleConversationChanged as EventListener
      );
      events.close();
    };
  }, [queryClient]);
}

function parseConversationChangedEvent(payload: string) {
  try {
    const parsed: unknown = JSON.parse(payload);

    if (!parsed || typeof parsed !== "object") {
      return null;
    }

    const conversationId = (parsed as { conversationId?: unknown })
      .conversationId;

    return typeof conversationId === "string" ? conversationId : null;
  } catch {
    return null;
  }
}

function ConversationLink(props: {
  conversation: ConversationListItem;
  active: boolean;
}) {
  const { conversation, active } = props;

  return (
    <Link
      className={active ? "conversation-row active" : "conversation-row"}
      to={`/conversations/${conversation.id}`}
    >
      <div className="row-main">
        <span className="phone-pair">
          {conversation.fromPhone}
          {" -> "}
          {conversation.toPhone}
        </span>
        <span className="last-message">
          {conversation.lastMessageBody ?? "No messages"}
        </span>
      </div>
      <div className="row-meta">
        {conversation.lastMessageStatus ? (
          <StatusPill
            status={conversation.lastMessageStatus}
            prefix={conversation.lastMessageDirection ?? undefined}
          />
        ) : null}
        <span>{conversation.messageCount}</span>
      </div>
    </Link>
  );
}

function ConversationDetail(props: {
  fromPhone: string;
  toPhone: string;
  messages: MessageDto[];
}) {
  return (
    <>
      <header className="detail-header">
        <div>
          <p className="eyebrow">Conversation</p>
          <h2>
            {props.fromPhone}
            {" -> "}
            {props.toPhone}
          </h2>
        </div>
        <span className="message-count">{props.messages.length} messages</span>
      </header>

      <ol className="message-list">
        {props.messages.map((message) => (
          <MessageRow key={message.id} message={message} />
        ))}
      </ol>
    </>
  );
}

function MessageRow(props: { message: MessageDto }) {
  const { message } = props;
  const isOutbound = message.direction === "outbound";

  return (
    <li className={isOutbound ? "message outbound" : "message inbound"}>
      <div className="message-topline">
        <span className="direction">
          {isOutbound ? <Send size={15} /> : <MessageSquare size={15} />}
          {message.direction}
        </span>
        <StatusPill status={message.status} />
      </div>
      <p>{message.body || "(empty message)"}</p>
      <time dateTime={message.createdAt}>
        {new Intl.DateTimeFormat(undefined, {
          dateStyle: "medium",
          timeStyle: "short"
        }).format(new Date(message.createdAt))}
      </time>
    </li>
  );
}

function StatusPill(props: { status: MessageStatus; prefix?: string | undefined }) {
  const icon = {
    received: <Inbox size={14} />,
    processing: <Clock3 size={14} />,
    sent: <CheckCircle2 size={14} />,
    failed: <AlertCircle size={14} />
  }[props.status];

  return (
    <span className={`status ${props.status}`}>
      {icon}
      {props.prefix ? `${props.prefix} ` : null}
      {props.status}
    </span>
  );
}

function EmptyDetail() {
  return (
    <div className="empty-detail">
      <MessageSquare size={26} />
      <h2>Select a conversation</h2>
      <Link className="primary-link" to="/test">
        <Webhook size={16} />
        Test Twilio endpoints
      </Link>
    </div>
  );
}

function StateLine(props: { icon: React.ReactNode; label: string }) {
  return (
    <div className="state-line">
      {props.icon}
      <span>{props.label}</span>
    </div>
  );
}

function RefreshLine(props: { label: string }) {
  return (
    <div className="refresh-line" role="status" aria-live="polite">
      <Loader2 size={16} />
      <span>{props.label}</span>
    </div>
  );
}

function TestConsole() {
  const [inbound, setInbound] = useState({
    messageSid: `SMTEST${Date.now()}`,
    from: "+5511999999999",
    to: "+15862044115",
    body: "Hello from the test console"
  });
  const [outbound, setOutbound] = useState({
    to: "",
    body: "Hello from LAHZO"
  });
  const [inboundResult, setInboundResult] = useState<string | null>(null);
  const [outboundResult, setOutboundResult] = useState<string | null>(null);
  const [inboundLoading, setInboundLoading] = useState(false);
  const [outboundLoading, setOutboundLoading] = useState(false);

  async function submitInbound(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setInboundLoading(true);
    setInboundResult(null);

    try {
      const result = await sendInboundWebhookTest(inbound);
      setInboundResult(JSON.stringify(result, null, 2));
    } catch (error) {
      setInboundResult(getErrorMessage(error));
    } finally {
      setInboundLoading(false);
    }
  }

  async function submitOutbound(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setOutboundLoading(true);
    setOutboundResult(null);

    try {
      const result = await sendOutboundSms(outbound);
      setOutboundResult(JSON.stringify(result, null, 2));
    } catch (error) {
      setOutboundResult(getErrorMessage(error));
    } finally {
      setOutboundLoading(false);
    }
  }

  return (
    <main className="test-page">
      <header className="test-header">
        <div>
          <p className="eyebrow">Twilio</p>
          <h1>Endpoint Test Console</h1>
        </div>
        <Link className="secondary-link" to="/">
          <MessageSquare size={16} />
          Conversations
        </Link>
      </header>

      <section className="test-grid">
        <form
          aria-label="Inbound webhook test"
          className="test-panel"
          onSubmit={submitInbound}
        >
          <div className="panel-heading">
            <Webhook size={20} />
            <div>
              <h2>Inbound Webhook</h2>
              <code>{getApiEndpoint("/webhooks/twilio/sms")}</code>
            </div>
          </div>

          <label>
            MessageSid
            <input
              value={inbound.messageSid}
              onChange={(event) =>
                setInbound({ ...inbound, messageSid: event.target.value })
              }
            />
          </label>
          <label>
            From
            <input
              value={inbound.from}
              onChange={(event) =>
                setInbound({ ...inbound, from: event.target.value })
              }
            />
          </label>
          <label>
            To
            <input
              value={inbound.to}
              onChange={(event) =>
                setInbound({ ...inbound, to: event.target.value })
              }
            />
          </label>
          <label>
            Body
            <textarea
              value={inbound.body}
              onChange={(event) =>
                setInbound({ ...inbound, body: event.target.value })
              }
            />
          </label>

          <button className="primary-button" type="submit" disabled={inboundLoading}>
            {inboundLoading ? <Loader2 size={16} /> : <Webhook size={16} />}
            Send inbound webhook
          </button>

          {inboundResult ? <pre className="result-box">{inboundResult}</pre> : null}
        </form>

        <form
          aria-label="Outbound API test"
          className="test-panel"
          onSubmit={submitOutbound}
        >
          <div className="panel-heading">
            <Send size={20} />
            <div>
              <h2>Outbound API</h2>
              <code>{getApiEndpoint("/api/messages/send")}</code>
            </div>
          </div>

          <label>
            To
            <input
              placeholder="+5511999999999"
              value={outbound.to}
              onChange={(event) =>
                setOutbound({ ...outbound, to: event.target.value })
              }
            />
          </label>
          <label>
            Body
            <textarea
              value={outbound.body}
              onChange={(event) =>
                setOutbound({ ...outbound, body: event.target.value })
              }
            />
          </label>

          <button
            className="primary-button"
            type="submit"
            disabled={outboundLoading}
          >
            {outboundLoading ? <Loader2 size={16} /> : <Send size={16} />}
            Send outbound SMS
          </button>

          {outboundResult ? (
            <pre className="result-box">{outboundResult}</pre>
          ) : null}
        </form>
      </section>
    </main>
  );
}

function getErrorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

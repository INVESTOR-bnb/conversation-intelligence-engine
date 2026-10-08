import { formatDate } from '../components/ui';
import type { ConversationMessage, Speaker } from '../domain/types';

const SPEAKER_LABEL: Record<Speaker, string> = {
  PROSPECT: 'Prospect',
  BUSINESS: 'Business',
  RECOVERY_MESSAGE: 'Recovery message',
  UNATTRIBUTED: 'Unattributed',
};

function timeLabel(at?: string) {
  if (!at) return null;
  return /^\d{4}-\d{2}-\d{2}T/.test(at) ? formatDate(at, true) : at;
}

export function ConversationView({ messages }: { messages: ConversationMessage[] }) {
  if (messages.length === 0) return <p className="muted">No conversation on record.</p>;
  return (
    <ol className="convo">
      {messages.map((m) => (
        <li key={m.id} className={`msg msg-${m.speaker.toLowerCase()}`}>
          <div className="msg-head">
            <span className="msg-speaker">
              {SPEAKER_LABEL[m.speaker]}
              {m.attempt ? ` · attempt ${m.attempt}` : ''}
              {m.isRecoveryResponse ? ' · response to recovery' : ''}
            </span>
            {timeLabel(m.at) && <span className="msg-time">{timeLabel(m.at)}</span>}
          </div>
          <p className="msg-text">{m.text}</p>
        </li>
      ))}
    </ol>
  );
}

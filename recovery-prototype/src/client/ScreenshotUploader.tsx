// Primary historical-conversation input: select screenshots, preview them in
// order, remove individual ones. Local only — see screenshotFiles.ts.

import { useRef, useState } from 'react';
import { Button, Icon } from '../components/ui';
import type { ConversationScreenshot } from '../domain/types';
import { ACCEPT_ATTR, isAcceptedImage, toLocalScreenshot } from './screenshotFiles';

export function ScreenshotUploader({
  screenshots,
  onChange,
  error,
}: {
  screenshots: ConversationScreenshot[];
  onChange: (next: ConversationScreenshot[]) => void;
  error?: string | null;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [problems, setProblems] = useState<string[]>([]);

  const addFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setBusy(true);
    const issues: string[] = [];
    const added: ConversationScreenshot[] = [];
    // Sequential so the selection order is preserved exactly.
    for (const file of Array.from(files)) {
      if (!isAcceptedImage(file)) {
        issues.push(`${file.name} is not a PNG, JPG or WebP image.`);
        continue;
      }
      try {
        added.push(await toLocalScreenshot(file));
      } catch (e) {
        issues.push(e instanceof Error ? e.message : `Couldn't read ${file.name}.`);
      }
    }
    onChange([...screenshots, ...added]);
    setProblems(issues);
    setBusy(false);
    if (inputRef.current) inputRef.current.value = ''; // allow re-selecting the same file
  };

  const count = screenshots.length;

  return (
    <div className="uploader">
      <p className="field-label" id="shots-label">Upload Conversation Screenshots</p>
      <p className="field-hint" id="shots-hint">
        Select screenshots of the conversation with this prospect. <strong>Add them in chronological order, oldest messages first.</strong>
      </p>

      <input
        ref={inputRef}
        id="shots-input"
        className="sr-only"
        type="file"
        accept={ACCEPT_ATTR}
        multiple
        aria-labelledby="shots-label"
        aria-describedby="shots-hint"
        onChange={(e) => addFiles(e.target.files)}
      />
      <Button block variant={count ? 'secondary' : 'primary'} onClick={() => inputRef.current?.click()} disabled={busy}>
        <Icon name="plus" /> {busy ? 'Preparing screenshots…' : count ? 'Add More Screenshots' : 'Select Screenshots'}
      </Button>
      <p className="muted small">PNG, JPG or WebP. You can select several at once.</p>

      <p className="shots-count" aria-live="polite">
        {count === 0 ? 'No screenshots selected' : `${count} screenshot${count === 1 ? '' : 's'} selected`}
      </p>

      {count > 0 && (
        <ol className="shots" aria-label="Selected screenshots, in order">
          {screenshots.map((s, i) => (
            <li key={s.id} className="shot">
              <span className="shot-num" aria-hidden="true">{i + 1}</span>
              <img src={s.dataUrl} alt={`Screenshot ${i + 1}: ${s.fileName}`} />
              <span className="shot-name">{s.fileName}</span>
              <button type="button" className="shot-remove" aria-label={`Remove screenshot ${i + 1} (${s.fileName})`} onClick={() => onChange(screenshots.filter((x) => x.id !== s.id))}>
                Remove
              </button>
            </li>
          ))}
        </ol>
      )}

      {problems.length > 0 && (
        <div className="banner banner-warn" role="alert">
          {problems.map((p, i) => <p key={i}>{p}</p>)}
        </div>
      )}
      {error && <p className="field-err" role="alert">{error}</p>}
    </div>
  );
}

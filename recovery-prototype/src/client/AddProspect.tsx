// C03 — add stalled prospect (two steps).

import { useState } from 'react';
import { Button, ErrorBanner, Field, Notice, ScreenHeader } from '../components/ui';
import { createCase, nextReference } from '../domain/transitions';
import { LEAD_SOURCES, type ConversationScreenshot, type LeadSource } from '../domain/types';
import { navigate } from '../router';
import { useStore } from '../state/store';
import { ScreenshotUploader } from './ScreenshotUploader';

export function AddProspectScreen() {
  const { data, apply } = useStore();
  const [step, setStep] = useState<1 | 2>(1);
  const [reference, setReference] = useState(() => nextReference(data));
  const [product, setProduct] = useState('');
  const [leadSource, setLeadSource] = useState<LeadSource | ''>('');
  const [value, setValue] = useState('');
  const [lastDate, setLastDate] = useState('');
  const [source, setSource] = useState<'SCREENSHOTS' | 'TEXT'>('SCREENSHOTS');
  const [screenshots, setScreenshots] = useState<ConversationScreenshot[]>([]);
  const [conversation, setConversation] = useState('');
  const [context, setContext] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitError, setSubmitError] = useState<string | null>(null);

  const goStep2 = () => {
    const e: Record<string, string> = {};
    if (!reference.trim()) e.reference = 'Enter a reference for this prospect.';
    if (!product.trim()) e.product = 'Enter the product or service.';
    if (!leadSource) e.leadSource = 'Choose a lead source (use “Unknown” if unsure).';
    if (value && !(Number(value.replace(/,/g, '')) >= 0)) e.value = 'Enter a number, e.g. 250000.';
    setErrors(e);
    if (Object.keys(e).length === 0) {
      setStep(2);
      window.scrollTo(0, 0);
    }
  };

  const submit = () => {
    if (source === 'SCREENSHOTS' && screenshots.length === 0) {
      setErrors({ screenshots: 'Add at least one screenshot of the conversation, or choose “Paste conversation instead”.' });
      return;
    }
    if (source === 'TEXT' && conversation.trim().length < 20) {
      setErrors({ conversation: 'Paste the conversation (at least a few messages) so we can understand what happened.' });
      return;
    }
    let caseId = '';
    const err = apply((d) => {
      const r = createCase(d, {
        clientId: d.demoClientId,
        reference,
        productService: product,
        leadSource: leadSource as LeadSource,
        estimatedDealValue: value ? Number(value.replace(/,/g, '')) : null,
        lastInteractionDate: lastDate || null,
        conversationSource: source,
        conversationText: source === 'TEXT' ? conversation : '',
        screenshots: source === 'SCREENSHOTS' ? screenshots : [],
        clientContext: context || null,
      });
      caseId = r.caseId;
      return r.data;
    });
    if (err) setSubmitError(err);
    else navigate({ name: 'client-submitted', id: caseId }, { replace: true });
  };

  return (
    <div className="screen narrow">
      <ScreenHeader
        title="Add Stalled Prospect"
        subtitle={`Step ${step} of 2 — ${step === 1 ? 'Deal' : 'Conversation'}`}
        onBack={() => (step === 2 ? setStep(1) : navigate({ name: 'client-dashboard' }))}
        backLabel={step === 2 ? 'Back to deal details' : 'Dashboard'}
      />
      <div className="progress" aria-hidden="true"><span style={{ width: step === 1 ? '50%' : '100%' }} /></div>

      {step === 1 ? (
        <form className="card" onSubmit={(e) => { e.preventDefault(); goStep2(); }} noValidate>
          <Field label="Prospect Reference" hint="A name or code you’ll recognise. Avoid full personal details." error={errors.reference}>
            {(id, d) => <input id={id} aria-describedby={d} value={reference} onChange={(e) => setReference(e.target.value)} />}
          </Field>
          <Field label="Product / Service" error={errors.product}>
            {(id, d) => <input id={id} aria-describedby={d} value={product} placeholder="e.g. 2018 Toyota Camry" onChange={(e) => setProduct(e.target.value)} />}
          </Field>
          <Field label="Lead Source" error={errors.leadSource}>
            {(id, d) => (
              <select id={id} aria-describedby={d} value={leadSource} onChange={(e) => setLeadSource(e.target.value as LeadSource)}>
                <option value="" disabled>Choose…</option>
                {LEAD_SOURCES.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            )}
          </Field>
          <Field label="Estimated Deal Value" optional error={errors.value}>
            {(id, d) => <input id={id} aria-describedby={d} inputMode="decimal" value={value} placeholder="e.g. 250000" onChange={(e) => setValue(e.target.value)} />}
          </Field>
          <Field label="Last Interaction Date" optional>
            {(id) => <input id={id} type="date" value={lastDate} onChange={(e) => setLastDate(e.target.value)} />}
          </Field>
          <Button type="submit" block>Continue</Button>
        </form>
      ) : (
        <form className="card" onSubmit={(e) => { e.preventDefault(); submit(); }} noValidate>
          {source === 'SCREENSHOTS' ? (
            <>
              <ScreenshotUploader screenshots={screenshots} onChange={(next) => { setScreenshots(next); setErrors({}); }} error={errors.screenshots} />
              <button type="button" className="text-link" onClick={() => { setSource('TEXT'); setErrors({}); }}>
                Paste conversation instead
              </button>
            </>
          ) : (
            <>
              <Field
                label="Sales conversation"
                hint={<>Paste the historical sales conversation below. Include enough of the conversation for us to understand what happened before the deal stalled.<br /><span className="muted">Tip: starting lines with “Prospect:” or “Business:” helps us tell speakers apart.</span></>}
                error={errors.conversation}
              >
                {(id, d) => (
                  <textarea id={id} aria-describedby={d} rows={12} value={conversation} placeholder={'Prospect: Is it still available?\nBusiness: Yes, it is…'} onChange={(e) => setConversation(e.target.value)} />
                )}
              </Field>
              <button type="button" className="text-link" onClick={() => { setSource('SCREENSHOTS'); setErrors({}); }}>
                Upload screenshots instead
              </button>
            </>
          )}
          <Field label="Anything we should know?" optional>
            {(id) => <textarea id={id} rows={3} value={context} onChange={(e) => setContext(e.target.value)} />}
          </Field>
          <Notice>Please avoid including unnecessary sensitive personal information.</Notice>
          <ErrorBanner message={submitError} />
          <Button type="submit" block>Submit for Review</Button>
        </form>
      )}
    </div>
  );
}

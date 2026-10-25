import { useState } from 'react';
import { useT } from '../i18n';
import { Icon } from './Icon';
import type { WorkflowDefinitionRecord, WorkflowNodeRecord } from './workflow-model';
import { rewriteWorkflowReferences } from './workflow-model';

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const display = (value: unknown) =>
  value === undefined ? '' : typeof value === 'string' ? value : JSON.stringify(value);
const literal = (value: string): unknown => {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
};
const uniqueKey = (values: Record<string, unknown>, prefix: string) => {
  let index = 1;
  while (Object.hasOwn(values, `${prefix}${index}`)) index += 1;
  return `${prefix}${index}`;
};

export function parseWorkflowParameters(
  definitions: Record<string, unknown>,
  values: Record<string, string>,
): { values: Record<string, unknown>; errors: Record<string, 'required' | 'invalid'> } {
  const parsed: Record<string, unknown> = {};
  const errors: Record<string, 'required' | 'invalid'> = {};
  for (const [name, raw] of Object.entries(definitions)) {
    const spec = record(raw);
    const text = values[name] ?? display(spec.default);
    if (text === '' && spec.default === undefined) {
      if (spec.required === true) errors[name] = 'required';
      continue;
    }
    const value = spec.type === 'string' || !spec.type ? text : literal(text);
    const valid =
      spec.type === 'number'
        ? typeof value === 'number' && Number.isFinite(value)
        : spec.type === 'boolean'
          ? typeof value === 'boolean'
          : spec.type === 'array'
            ? Array.isArray(value)
            : spec.type === 'object'
              ? value !== null && typeof value === 'object' && !Array.isArray(value)
              : typeof value === 'string';
    if (
      !valid ||
      (Array.isArray(spec.enum) &&
        !spec.enum.some((entry) => JSON.stringify(entry) === JSON.stringify(value)))
    )
      errors[name] = 'invalid';
    else Object.defineProperty(parsed, name, { value, enumerable: true });
  }
  return { values: parsed, errors };
}

export function WorkflowRunParameters({
  definition,
  onRun,
  onCancel,
  busy,
}: {
  definition: WorkflowDefinitionRecord;
  onRun: (values: Record<string, unknown>) => void;
  onCancel: () => void;
  busy: boolean;
}) {
  const t = useT();
  const [values, setValues] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, 'required' | 'invalid'>>({});
  return (
    <form
      className="wf-run-setup"
      data-testid="workflow-run-setup"
      onSubmit={(event) => {
        event.preventDefault();
        const parsed = parseWorkflowParameters(definition.parameters, values);
        setErrors(parsed.errors);
        if (!Object.keys(parsed.errors).length) onRun(parsed.values);
      }}
    >
      <strong>{t('workflow.runSetup')}</strong>
      <div className="wf-parameter-grid">
        {Object.entries(definition.parameters).map(([name, raw]) => {
          const spec = record(raw);
          const value = values[name] ?? display(spec.default);
          return (
            <label key={name} className="wf-field">
              <span>
                {name}
                {spec.required ? ' *' : ''} <small>{String(spec.type ?? 'string')}</small>
              </span>
              {spec.type === 'boolean' ? (
                <select
                  value={value}
                  aria-invalid={!!errors[name]}
                  onChange={(event) => setValues({ ...values, [name]: event.target.value })}
                >
                  <option value=""></option>
                  <option value="true">true</option>
                  <option value="false">false</option>
                </select>
              ) : Array.isArray(spec.enum) ? (
                <select
                  value={value}
                  aria-invalid={!!errors[name]}
                  onChange={(event) => setValues({ ...values, [name]: event.target.value })}
                >
                  <option value=""></option>
                  {spec.enum.map((item) => (
                    <option key={display(item)} value={display(item)}>
                      {display(item)}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  value={value}
                  type={spec.type === 'number' ? 'number' : 'text'}
                  step="any"
                  aria-invalid={!!errors[name]}
                  onChange={(event) => setValues({ ...values, [name]: event.target.value })}
                />
              )}
              {typeof spec.description === 'string' ? <small>{spec.description}</small> : null}
              {errors[name] ? (
                <span className="wf-run-error">
                  {t(
                    errors[name] === 'required'
                      ? 'workflow.missingRequired'
                      : 'workflow.fieldInvalid',
                    { name },
                  )}
                </span>
              ) : null}
            </label>
          );
        })}
      </div>
      {!Object.keys(definition.parameters).length ? (
        <span>{t('workflow.emptyParameters')}</span>
      ) : null}
      <div className="wf-conflict-actions">
        <button className="wf-btn wf-btn-primary" type="submit" disabled={busy}>
          <Icon name="play" size={12} />
          {t('workflow.runConfirm')}
        </button>
        <button className="wf-btn" type="button" disabled={busy} onClick={onCancel}>
          {t('common.cancel')}
        </button>
      </div>
    </form>
  );
}

export function WorkflowSettings({
  definition,
  onChange,
}: {
  definition: WorkflowDefinitionRecord;
  onChange: (patch: Partial<WorkflowDefinitionRecord>) => void;
}) {
  const t = useT();
  const [error, setError] = useState<string | null>(null);
  const parameters = definition.parameters;
  return (
    <div className="wf-settings-form">
      <h3>{t('workflow.parameters')}</h3>
      {Object.entries(parameters).map(([name, raw]) => {
        const spec = record(raw);
        const patch = (value: Record<string, unknown>) =>
          onChange({ parameters: { ...parameters, [name]: { ...spec, ...value } } });
        const invalidDefault =
          spec.default !== undefined &&
          !!parseWorkflowParameters({ [name]: spec }, {}).errors[name];
        return (
          <fieldset key={name}>
            <legend>{name}</legend>
            <label className="wf-field">
              <span>{t('workflow.label')}</span>
              <input
                defaultValue={name}
                onBlur={(event) => {
                  const key = event.target.value.trim();
                  if (key === name) return;
                  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || Object.hasOwn(parameters, key)) {
                    event.target.value = name;
                    setError(t('workflow.fieldInvalid', { name: key }));
                    return;
                  }
                  const next = { ...parameters };
                  delete next[name];
                  next[key] = spec;
                  onChange({
                    ...rewriteWorkflowReferences(definition, 'parameters', name, key),
                    parameters: next,
                  });
                  setError(null);
                }}
              />
            </label>
            <label className="wf-field">
              <span>{t('workflow.nodeType')}</span>
              <select
                value={String(spec.type ?? 'string')}
                onChange={(event) => patch({ type: event.target.value })}
              >
                {['string', 'number', 'boolean', 'object', 'array'].map((type) => (
                  <option key={type}>{type}</option>
                ))}
              </select>
            </label>
            <label className="wf-field">
              <span>{t('workflow.default')}</span>
              <input
                value={display(spec.default)}
                aria-invalid={invalidDefault}
                onChange={(event) => {
                  const next = { ...spec };
                  if (!event.target.value) delete next.default;
                  else
                    next.default =
                      spec.type === 'string' || !spec.type
                        ? event.target.value
                        : literal(event.target.value);
                  onChange({ parameters: { ...parameters, [name]: next } });
                }}
              />
              {invalidDefault ? (
                <span className="wf-run-error">{t('workflow.fieldInvalid', { name })}</span>
              ) : null}
            </label>
            <label className="wf-check">
              <input
                type="checkbox"
                checked={spec.required === true}
                onChange={(event) => patch({ required: event.target.checked })}
              />
              {t('workflow.required')}
            </label>
            <button
              className="wf-btn wf-btn-icon"
              title={t('workflow.deleteNode')}
              aria-label={`${t('workflow.deleteNode')} ${name}`}
              onClick={() => {
                const next = { ...parameters };
                delete next[name];
                onChange({ parameters: next });
              }}
            >
              <Icon name="trash" size={14} />
            </button>
          </fieldset>
        );
      })}
      {error ? (
        <p className="wf-run-error" role="alert">
          {error}
        </p>
      ) : null}
      <button
        className="wf-btn"
        onClick={() =>
          onChange({
            parameters: {
              ...parameters,
              [uniqueKey(parameters, 'parameter')]: { type: 'string', required: true },
            },
          })
        }
      >
        <Icon name="plus" size={12} />
        {t('workflow.addParameter')}
      </button>
      <h3>{t('workflow.outputs')}</h3>
      <WorkflowBindings
        values={definition.outputs}
        definition={definition}
        outputs
        onChange={(outputs) => onChange({ outputs })}
      />
    </div>
  );
}

export function WorkflowBindings({
  values,
  definition,
  nodeId,
  outputs,
  onChange,
}: {
  values: Record<string, unknown>;
  definition: WorkflowDefinitionRecord;
  nodeId?: string;
  outputs?: boolean;
  onChange: (values: Record<string, unknown>) => void;
}) {
  const t = useT();
  const [error, setError] = useState<string | null>(null);
  // Only offer upstream node outputs; execution dependencies remain explicit.
  const ancestors = new Set<string>();
  const visit = (id: string) => {
    for (const parent of definition.nodes.find((node) => node.id === id)?.dependsOn ?? [])
      if (!ancestors.has(parent)) {
        ancestors.add(parent);
        visit(parent);
      }
  };
  if (nodeId) visit(nodeId);
  const options = Object.keys(definition.parameters).map((name) => `{{ parameters.${name} }}`);
  for (const node of definition.nodes)
    if (!nodeId || ancestors.has(node.id)) {
      const keys = new Set([
        ...Object.keys(record(node.outputContract)),
        ...Object.keys(record(record(node.outputSchema).properties)),
        ...(node.type === 'exec' ? ['stdout', 'stderr', 'exitCode'] : ['result']),
      ]);
      for (const key of keys) options.push(`{{ nodes.${node.id}.outputs.${key} }}`);
    }
  const change = (name: string, value: unknown) =>
    onChange({ ...values, [name]: outputs ? { ...record(values[name]), value } : value });
  return (
    <div className="wf-bindings">
      {Object.entries(values).map(([name, value]) => (
        <fieldset key={name}>
          <label className="wf-field">
            <span>{t('workflow.label')}</span>
            <input
              defaultValue={name}
              onBlur={(event) => {
                const key = event.target.value.trim();
                if (key === name) return;
                if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || Object.hasOwn(values, key)) {
                  setError(t('workflow.fieldInvalid', { name: key }));
                  event.target.value = name;
                  return;
                }
                const next = { ...values };
                delete next[name];
                next[key] = value;
                onChange(next);
                setError(null);
              }}
            />
          </label>
          <label className="wf-field">
            <span>{t('workflow.bindingSource')}</span>
            <select
              value=""
              onChange={(event) => {
                if (event.target.value) change(name, event.target.value);
              }}
            >
              <option value=""></option>
              {options.map((option) => (
                <option key={option}>{option}</option>
              ))}
            </select>
          </label>
          <input
            aria-label={`${name} value`}
            value={display(outputs ? record(value).value : value)}
            onChange={(event) => change(name, literal(event.target.value))}
          />
          <button
            className="wf-btn wf-btn-icon"
            title={t('workflow.deleteNode')}
            aria-label={`${t('workflow.deleteNode')} ${name}`}
            onClick={() => {
              const next = { ...values };
              delete next[name];
              onChange(next);
            }}
          >
            <Icon name="trash" size={14} />
          </button>
        </fieldset>
      ))}
      {error ? <p className="wf-run-error">{error}</p> : null}
      <button
        className="wf-btn"
        onClick={() =>
          onChange({
            ...values,
            [uniqueKey(values, outputs ? 'output' : 'input')]: outputs ? { value: '' } : '',
          })
        }
      >
        <Icon name="plus" size={12} />
        {t('workflow.addBinding')}
      </button>
    </div>
  );
}

export function WorkflowChecks({
  node,
  onChange,
}: {
  node: WorkflowNodeRecord;
  onChange: (checks: unknown[]) => void;
}) {
  const t = useT();
  const checks = Array.isArray(node.checks) ? node.checks : [];
  const types = [
    'expression',
    'file_exists',
    'file_size',
    'grep',
    'regex',
    'numeric_range',
    'json_schema',
  ];
  return (
    <div className="wf-checks-form">
      {checks.map((raw, index) => {
        const check = record(raw);
        const type = String(check.type ?? 'expression');
        const patch = (value: Record<string, unknown>) =>
          onChange(
            checks.map((entry, current) => (current === index ? { ...check, ...value } : entry)),
          );
        const fields =
          type === 'file_exists'
            ? ['path']
            : type === 'file_size'
              ? ['path', 'minBytes', 'maxBytes']
              : type === 'grep'
                ? ['path', 'pattern', 'flags']
                : type === 'regex'
                  ? ['value', 'pattern', 'flags']
                  : type === 'numeric_range'
                    ? ['value', 'min', 'max', 'notEqual']
                    : type === 'json_schema'
                      ? ['value', 'schema']
                      : ['value'];
        return (
          <fieldset key={`${index}:${type}`}>
            <legend>{index + 1}</legend>
            <select
              aria-label={t('workflow.checks')}
              value={type}
              onChange={(event) => patch({ type: event.target.value })}
            >
              {types.map((entry) => (
                <option key={entry}>{entry}</option>
              ))}
            </select>
            {fields.map((field) => (
              <label key={field} className="wf-field">
                <span>{field}</span>
                <input
                  value={display(check[field])}
                  onChange={(event) => patch({ [field]: literal(event.target.value) })}
                />
              </label>
            ))}
            <label className="wf-check">
              <input
                type="checkbox"
                checked={check.negate === true}
                onChange={(event) => patch({ negate: event.target.checked })}
              />
              negate
            </label>
            <button
              className="wf-btn wf-btn-icon"
              title={t('workflow.deleteNode')}
              aria-label={`${t('workflow.deleteNode')} ${index + 1}`}
              onClick={() => onChange(checks.filter((_, current) => current !== index))}
            >
              <Icon name="trash" size={14} />
            </button>
          </fieldset>
        );
      })}
      <button
        className="wf-btn"
        onClick={() => onChange([...checks, { type: 'file_exists', path: '' }])}
      >
        <Icon name="plus" size={12} />
        {t('workflow.addCheck')}
      </button>
    </div>
  );
}

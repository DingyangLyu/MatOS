"use client";

// MatOS BYOK provider card — "use your own DeepSeek key and model".
//
// Writes the user's DeepSeek settings (API key, optional base URL and model)
// through the daemon
// login bridge (`/api/matos/login/*`) into the native per-scope
// `matos login` profile — the runtime's highest-priority provider source, so
// the user's key/model win over every deployment default and model preset on
// each following run. Saving always runs a REAL provider round-trip
// (`matos login test`), so "saved" means "verified working".
//
// The API key is write-only: it travels once in the save request and never
// echoes back — the status endpoint only reports `hasSecret`.

import { useCallback, useEffect, useState } from "react";
import type { Locale } from "../i18n";
import { Icon } from "./Icon";

const STATUS_ENDPOINT = "/api/matos/login/status";
const SET_ENDPOINT = "/api/matos/login/set";
const TEST_ENDPOINT = "/api/matos/login/test";
const RESET_ENDPOINT = "/api/matos/login/reset";

interface LoginStatus {
  providerType?: string;
  baseUrl?: string;
  model?: string;
  source?: string;
  status?: string;
  hasSecret?: boolean;
  validatedAt?: string;
  lastValidationError?: string;
}

type Copy = {
  title: string;
  description: string;
  loading: string;
  activeUser: string;
  activeDeployment: string;
  notConfigured: string;
  validated: string;
  failed: string;
  baseUrl: string;
  apiKey: string;
  apiKeySavedPlaceholder: string;
  apiKeyPlaceholder: string;
  model: string;
  save: string;
  saving: string;
  test: string;
  testing: string;
  reset: string;
  resetting: string;
  saveOk: string;
  testOk: string;
  resetOk: string;
  needFields: string;
  privacy: string;
};

const EN_COPY: Copy = {
  title: "Use your own DeepSeek API key",
  description:
    "Save your DeepSeek key (and optionally a base URL or model) as this workspace's provider profile. It takes priority over the deployment default for every run.",
  loading: "Checking the current provider…",
  activeUser: "Your provider is active",
  activeDeployment: "Deployment default",
  notConfigured: "Not configured",
  validated: "Verified",
  failed: "Last validation failed",
  baseUrl: "Base URL",
  apiKey: "API key",
  apiKeySavedPlaceholder: "Saved — enter a new key to replace",
  apiKeyPlaceholder: "Paste your DeepSeek API key",
  model: "Model (optional)",
  save: "Save & verify",
  saving: "Verifying with the provider…",
  test: "Test",
  testing: "Testing…",
  reset: "Use deployment default",
  resetting: "Restoring…",
  saveOk: "Provider verified and active. New runs use your model.",
  testOk: "Provider round-trip succeeded.",
  resetOk: "Restored the deployment default provider.",
  needFields: "An API key is required.",
  privacy:
    "The key is stored in this workspace's MatOS credential file (0600) and is never echoed back to this page or logged.",
};

const ZH_COPY: Copy = {
  title: "使用自己的 DeepSeek API Key",
  description:
    "保存你的 DeepSeek Key（可选填 Base URL 和模型），作为本工作区的模型服务配置，每次运行都优先于部署默认。",
  loading: "正在检查当前模型服务…",
  activeUser: "正在使用你的配置",
  activeDeployment: "部署默认",
  notConfigured: "未配置",
  validated: "已验证",
  failed: "上次验证失败",
  baseUrl: "Base URL",
  apiKey: "API Key",
  apiKeySavedPlaceholder: "已保存——输入新 Key 可替换",
  apiKeyPlaceholder: "粘贴你的 DeepSeek API Key",
  model: "模型（可选）",
  save: "保存并验证",
  saving: "正在向服务商验证…",
  test: "测试",
  testing: "测试中…",
  reset: "恢复部署默认",
  resetting: "恢复中…",
  saveOk: "验证通过，配置已生效。之后的运行将使用你的模型。",
  testOk: "服务商连通性验证通过。",
  resetOk: "已恢复为部署默认模型服务。",
  needFields: "请填写 API Key。",
  privacy:
    "Key 保存在本工作区的 MatOS 凭证文件中（0600 权限），不会回显到页面，也不会写入日志。",
};

function copyFor(locale: Locale): Copy {
  return locale === "zh-CN" || locale === "zh-TW" ? ZH_COPY : EN_COPY;
}

async function postJson(url: string, body?: unknown): Promise<Record<string, unknown>> {
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = (await resp.json().catch(() => null)) as Record<string, unknown> | null;
  if (!data) throw new Error(`HTTP ${resp.status}`);
  return data;
}

export function MatOSByokProviderCard({ locale }: { locale: Locale }) {
  const copy = copyFor(locale);
  const [status, setStatus] = useState<LoginStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<"save" | "test" | "reset" | null>(null);
  const [notice, setNotice] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("");

  const refresh = useCallback(async () => {
    try {
      const resp = await fetch(STATUS_ENDPOINT, { headers: { Accept: "application/json" } });
      const data = (await resp.json().catch(() => null)) as
        | { ok?: boolean; status?: LoginStatus }
        | null;
      const next = data?.status ?? null;
      setStatus(next);
      // Seed the form from the active USER profile so editing starts from
      // what is running; a deployment default stays as placeholders.
      if (next?.source === "profile") {
        setBaseUrl((current) => current || next.baseUrl || "");
        setModel((current) => current || next.model || "");
      }
    } catch {
      setStatus(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const userActive = status?.source === "profile";

  const onSave = useCallback(async () => {
    if (!apiKey.trim()) {
      setNotice({ kind: "error", text: copy.needFields });
      return;
    }
    setBusy("save");
    setNotice(null);
    try {
      const result = await postJson(SET_ENDPOINT, {
        apiKey: apiKey.trim(),
        ...(baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}),
        ...(model.trim() ? { model: model.trim() } : {}),
      });
      const resultStatus = (result.status ?? {}) as LoginStatus;
      if (result.ok === true && resultStatus.status !== "failed") {
        setNotice({ kind: "ok", text: copy.saveOk });
        setApiKey("");
      } else {
        setNotice({
          kind: "error",
          text: resultStatus.lastValidationError ||
            (typeof result.message === "string" ? result.message : "") ||
            (typeof result.error === "string" ? result.error : "") ||
            copy.failed,
        });
      }
    } catch (error) {
      setNotice({ kind: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(null);
      void refresh();
    }
  }, [apiKey, baseUrl, copy, model, refresh]);

  const onTest = useCallback(async () => {
    setBusy("test");
    setNotice(null);
    try {
      const result = await postJson(TEST_ENDPOINT);
      const resultStatus = (result.status ?? {}) as LoginStatus;
      setNotice(
        result.ok === true && resultStatus.status !== "failed"
          ? { kind: "ok", text: copy.testOk }
          : {
              kind: "error",
              text: resultStatus.lastValidationError ||
                (typeof result.message === "string" ? result.message : "") ||
                copy.failed,
            },
      );
    } catch (error) {
      setNotice({ kind: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(null);
      void refresh();
    }
  }, [copy, refresh]);

  const onReset = useCallback(async () => {
    setBusy("reset");
    setNotice(null);
    try {
      const result = await postJson(RESET_ENDPOINT);
      setNotice(
        result.ok === true
          ? { kind: "ok", text: copy.resetOk }
          : { kind: "error", text: typeof result.error === "string" ? result.error : copy.failed },
      );
      setBaseUrl("");
      setApiKey("");
      setModel("");
    } catch (error) {
      setNotice({ kind: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(null);
      void refresh();
    }
  }, [copy, refresh]);

  return (
    <section className="matos-byok-provider" data-testid="matos-byok-provider">
      <div className="matos-byok-provider__head">
        <span className="matos-byok-provider__icon" aria-hidden>
          <Icon name="plug" size={15} />
        </span>
        <div className="matos-byok-provider__intro">
          <div className="matos-byok-provider__title-row">
            <h4>{copy.title}</h4>
            {loading ? null : userActive ? (
              <span className="matos-byok-provider__badge matos-byok-provider__badge--active">
                <span className="matos-byok-provider__dot" aria-hidden />
                {copy.activeUser}
                {status?.status === "validated" ? ` · ${copy.validated}` : ""}
              </span>
            ) : (
              // No profile and no deployment key: say so instead of implying
              // a working default.
              <span className="matos-byok-provider__badge">
                {status?.source === "none" && !status?.hasSecret ? copy.notConfigured : copy.activeDeployment}
              </span>
            )}
          </div>
          <p>{copy.description}</p>
        </div>
      </div>
      {loading ? (
        <div className="matos-byok-provider__status">{copy.loading}</div>
      ) : (
        <>
          {userActive && status ? (
            <div className="matos-byok-provider__status" data-testid="matos-byok-active-summary">
              {status.baseUrl} · {status.model}
              {status.status === "failed" && status.lastValidationError
                ? ` · ${copy.failed}: ${status.lastValidationError}`
                : ""}
            </div>
          ) : null}
          <div className="matos-byok-provider__form">
            <label className="matos-byok-provider__field">
              <span>{copy.baseUrl}</span>
              <input
                type="text"
                value={baseUrl}
                placeholder="https://api.deepseek.com/anthropic"
                data-testid="matos-byok-base-url"
                onChange={(event) => setBaseUrl(event.target.value)}
              />
            </label>
            <label className="matos-byok-provider__field">
              <span>{copy.apiKey}</span>
              <input
                type="password"
                value={apiKey}
                placeholder={
                  status?.hasSecret && userActive
                    ? copy.apiKeySavedPlaceholder
                    : copy.apiKeyPlaceholder
                }
                autoComplete="off"
                data-testid="matos-byok-api-key"
                onChange={(event) => setApiKey(event.target.value)}
              />
            </label>
            <label className="matos-byok-provider__field">
              <span>{copy.model}</span>
              <input
                type="text"
                value={model}
                placeholder="deepseek-flash"
                data-testid="matos-byok-model"
                onChange={(event) => setModel(event.target.value)}
              />
            </label>
          </div>
          {notice ? (
            <div
              className={`matos-byok-provider__notice matos-byok-provider__notice--${notice.kind}`}
              role="status"
              data-testid="matos-byok-notice"
            >
              {notice.text}
            </div>
          ) : null}
          <div className="matos-byok-provider__actions">
            <button
              type="button"
              className="primary"
              disabled={busy !== null}
              data-testid="matos-byok-save"
              onClick={() => void onSave()}
            >
              {busy === "save" ? (
                <>
                  <Icon name="spinner" size={13} className="icon-spin" />
                  {copy.saving}
                </>
              ) : (
                copy.save
              )}
            </button>
            {userActive ? (
              <>
                <button
                  type="button"
                  className="ghost"
                  disabled={busy !== null}
                  data-testid="matos-byok-test"
                  onClick={() => void onTest()}
                >
                  {busy === "test" ? copy.testing : copy.test}
                </button>
                <button
                  type="button"
                  className="ghost"
                  disabled={busy !== null}
                  data-testid="matos-byok-reset"
                  onClick={() => void onReset()}
                >
                  {busy === "reset" ? copy.resetting : copy.reset}
                </button>
              </>
            ) : null}
          </div>
          <p className="matos-byok-provider__privacy">{copy.privacy}</p>
        </>
      )}
    </section>
  );
}

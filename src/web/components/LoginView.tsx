import { useState, type FormEvent } from "react";
import { AlertTriangle, KeyRound, Lock } from "lucide-react";
import { api, ApiClientError } from "../api.ts";
import { describeClientErrorRef, t, type LocalizedError } from "../i18n.ts";
import { useUiStore } from "../stores/uiStore.ts";
import { BrandMark } from "./BrandMark.tsx";
import { Icon } from "./Icon.tsx";
import { UiLanguageSelect } from "./Primitives.tsx";

export function LoginView({ onAuthenticated }: { onAuthenticated: () => void }) {
  const language = useUiStore((s) => s.language);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<LocalizedError | null>(null);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!password.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.login(password);
      onAuthenticated();
    } catch (err) {
      setError(
        err instanceof ApiClientError && err.code === "unauthorized"
          ? { key: "login.invalidPin", text: "" }
          : describeClientErrorRef(err),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 20,
        background: "var(--bg)",
      }}
      data-testid="login-view"
    >
      <form
        onSubmit={(e) => void handleSubmit(e)}
        style={{
          width: "100%",
          maxWidth: 400,
          background: "var(--surface)",
          border: "1px solid var(--border)",
          borderRadius: 12,
          padding: 24,
          boxShadow: "0 12px 32px rgba(0, 0, 0, 0.08)",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, marginBottom: 12 }}>
          <span className="muted xs">{t(language, "app.languageLabel")}</span>
          <UiLanguageSelect />
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
          <BrandMark />
          <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>{t(language, "login.title")}</h2>
        </div>
        <p className="muted xs" style={{ margin: "0 0 16px" }}>
          {t(language, "login.descPrefix")}
          <code>{t(language, "login.descCommand")}</code>
          {t(language, "login.descSuffix")}
        </p>

        <label className="muted xs" htmlFor="login-password" style={{ display: "block", marginBottom: 6 }}>
          {t(language, "login.passwordLabel")}
        </label>
        <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 12 }}>
          <span className="muted" style={{ display: "inline-flex" }}>
            <Icon icon={Lock} size={16} />
          </span>
          <input
            id="login-password"
            data-testid="login-password-input"
            type="password"
            autoFocus
            className="input"
            placeholder={t(language, "login.passwordPlaceholder")}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>

        {error && (
          <div className="callout danger xs" style={{ marginBottom: 12 }} data-testid="login-error">
            <Icon icon={AlertTriangle} size={14} />{" "}
            {error.key ? t(language, error.key, error.params) : error.text}
          </div>
        )}

        <button
          className="btn primary"
          type="submit"
          data-testid="login-submit-btn"
          style={{ width: "100%", justifyContent: "center" }}
          disabled={busy || !password.trim()}
        >
          <Icon icon={KeyRound} size={16} /> {busy ? t(language, "login.verifying") : t(language, "login.submit")}
        </button>
      </form>
    </div>
  );
}